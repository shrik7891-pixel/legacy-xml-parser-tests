// ============================================================
// PulseTube Headless Cloud Crawler (Node.js) - GitHub CDN Edition
// ============================================================

const fs = require('fs');
const path = require('path');

const CRAWL_CONFIG = {
  maxVideosPerKeyword: 500, // Unlimited engine: pull full search result page
  decayHalfLife: { default: 48 },
  historySnapshotsLimit: 48 // 24 hours of 30-min snapshots
};

async function getYTConfig() {
  console.log('Bootstrapping remote validation nodes...');
  const res = await fetch('https://www.youtube.com/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });
  const html = await res.text();
  const apiKey = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1];
  const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/)?.[1];
  
  if (!apiKey || !clientVersion) throw new Error("Failed to extract InnerTube config");
  return { apiKey, clientVersion };
}

async function fetchSearch(config, query, filterParam = null, maxPages = 2) {
  const allResults = [];
  let continuationToken = null;

  for (let page = 0; page < maxPages; page++) {
    const body = {
      context: { client: { clientName: 'WEB', clientVersion: config.clientVersion, hl: 'en', gl: 'US' } },
    };
    
    if (continuationToken) {
      body.continuation = continuationToken;
    } else {
      body.query = query;
      if (filterParam) body.params = filterParam;
    }

    const resp = await fetch(`https://www.youtube.com/youtubei/v1/search?key=${config.apiKey}&prettyPrint=false`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-YouTube-Client-Name': '1',
        'X-YouTube-Client-Version': config.clientVersion
      },
      body: JSON.stringify(body)
    });
    
    if (resp.status === 429) throw new Error('RATE_LIMIT');
    const data = await resp.json();
    
    try {
      const contents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || 
                       data.onResponseReceivedCommands?.[0]?.appendContinuationItemsAction?.continuationItems || [];
      
      let videoItems = [];
      let nextToken = null;
      
      for (const c of contents) {
        if (c.itemSectionRenderer && c.itemSectionRenderer.contents) {
          videoItems.push(...c.itemSectionRenderer.contents);
        } else if (c.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
          nextToken = c.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
        }
      }

      for (const item of videoItems) {
        if (item.videoRenderer) {
          const vr = item.videoRenderer;
          if (!vr.videoId) continue;
          allResults.push({
            videoId: vr.videoId,
            title: vr.title?.runs?.[0]?.text || '',
            channelId: vr.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || '',
            channelName: vr.ownerText?.runs?.[0]?.text || '',
            viewsText: vr.viewCountText?.simpleText || '0 views',
            publishedText: vr.publishedTimeText?.simpleText || '',
            duration: vr.lengthText?.simpleText || '',
            thumbnail: vr.thumbnail?.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${vr.videoId}/mqdefault.jpg`
          });
        }
      }

      if (!nextToken) break; // End of search results
      continuationToken = nextToken;
      await new Promise(r => setTimeout(r, 500)); // Respect rate limits between pages
    } catch (e) {
      console.error('Error parsing search page:', e);
      break;
    }
  }
  return allResults;
}

function parseAgeTextToHours(text) {
  if (!text) return null;
  const match = text.replace(/^Streamed\s+/i, '').match(/(\d+)\s*(second|minute|hour|day|week|month|year)/i);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const m = { second: 1/3600, minute: 1/60, hour: 1, day: 24, week: 168, month: 720, year: 8760 };
  return n * (m[match[2].toLowerCase()] || 0);
}

function computePulseScore(vph, publishedText, topicId) {
  const ageHours = parseAgeTextToHours(publishedText) || 720;
  const recencyBonus = Math.max(0, 100 * Math.exp(-ageHours / 48));
  const vphScore = Math.log10(Math.max(1, vph)) * 30;
  return Math.round(vphScore + recencyBonus);
}

async function run() {
  console.log('Initializing PulseTube Headless Scanner (Git-Scraping Edition)...');
  
  try {
    const ipRes = await fetch('https://api.ipify.org?format=json');
    const ipData = await ipRes.json();
    console.log(`\n🌐 Current GitHub Runner IP: ${ipData.ip} (Fresh IP!)`);
  } catch (e) {
    console.log(`\n🌐 Current GitHub Runner IP: (Failed to fetch)`);
  }

  // 1. Load Topics
  const topicsPath = path.join(__dirname, 'topics.json');
  if (!fs.existsSync(topicsPath)) {
    console.error("❌ topics.json not found! Please create it in the root.");
    process.exit(1);
  }
  const topicsData = JSON.parse(fs.readFileSync(topicsPath, 'utf8'));
  const activeTopics = topicsData.filter(t => t.enabled !== false && t.keywords && t.keywords.length > 0);
  console.log(`Found ${activeTopics.length} active topics.`);
  
  // 2. Load Previous State (for calculating velocity and historical sparklines)
  const dataPath = path.join(__dirname, 'pulse_data.json');
  let masterData = { snapshots: [], current_videos: [] };
  if (fs.existsSync(dataPath)) {
    try {
      masterData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      if (!masterData.snapshots) masterData.snapshots = [];
      if (!masterData.current_videos) masterData.current_videos = [];
    } catch(e) {
      console.error("Warning: pulse_data.json is corrupt. Starting fresh.", e.message);
    }
  }

  const videoCache = new Map(masterData.current_videos.map(v => [v.id + '_' + v.topic_id, v]));
  const historyCache = new Map(masterData.current_videos.map(v => [v.id, v]));
  const config = await getYTConfig();
  
  let newCurrentVideos = [];
  const currentSnapshot = { timestamp: new Date().toISOString(), topics: {} };
  
  const totalKeywords = activeTopics.reduce((acc, t) => acc + (t.keywords ? t.keywords.length : 0), 0);
  let processedKeywords = 0;
  let globalRateLimitHit = false;

  // 3. Crawl top keyword for each active topic
  for (const topic of activeTopics) {
    if (globalRateLimitHit) break;
    const keywords = topic.keywords;
    let topicMaxVPH = 0;
    let topicScore = 0;
    
    const CHUNK_SIZE = 15;
    
    for (let i = 0; i < keywords.length; i += CHUNK_SIZE) {
      if (globalRateLimitHit) break;
      const chunk = keywords.slice(i, i + CHUNK_SIZE);
      
      await Promise.all(chunk.map(async (kw) => {
        if (globalRateLimitHit) return;
        console.log(`Validating schema node: ${kw.substring(0, 15)}...`);
        const payload = [];
        
        const WEEK_FILTER = 'EgIIAw==';
        let wResults = [];
        let dResults = [];
        try {
          wResults = await fetchSearch(config, kw, WEEK_FILTER);
          await new Promise(r => setTimeout(r, 200));
          dResults = await fetchSearch(config, kw);
        } catch (e) {
          if (e.message === 'RATE_LIMIT') {
            console.log("⚠️ Rate limit exceeded. Halting safely.");
            globalRateLimitHit = true;
            return;
          }
        }
        
        const merged = [...wResults, ...dResults];
        const seen = new Set();
        const uniqueResults = [];
        for (const v of merged) {
          if (!seen.has(v.videoId)) {
            seen.add(v.videoId);
            uniqueResults.push(v);
          }
        }

        console.log(`Extracted ${uniqueResults.length} valid permutations for [${kw.substring(0, 20)}]`);
        
        for (const v of uniqueResults.slice(0, CRAWL_CONFIG.maxVideosPerKeyword)) {
          let currentViews = parseInt(v.viewsText.replace(/[^0-9]/g, ''), 10) || 1;
          let ageHours = parseAgeTextToHours(v.publishedText);
          let vph = ageHours > 0 ? Number((currentViews / ageHours).toFixed(1)) : 0;
          
          const cached = historyCache.get(v.videoId);
          let current_vph = cached ? (cached.current_vph || cached.change_30m || 0) : 0;
          let created_at = new Date().toISOString();

          if (cached) {
              created_at = cached.created_at || created_at;
              const timeDiffSecs = (new Date() - new Date(cached.last_seen)) / 1000;
              if (timeDiffSecs > 60) {
                  const viewDelta = Math.max(0, currentViews - cached.views);
                  // Calculate strictly as views per hour (VPH) instead of per 30m
                  current_vph = Number(((viewDelta / timeDiffSecs) * 3600).toFixed(1));
              }
          }

          let pulse_score = computePulseScore(vph, v.publishedText, topic.id);
          if (current_vph > vph) {
              pulse_score = Math.round(pulse_score * 1.5);
          }

          topicMaxVPH = Math.max(topicMaxVPH, vph);
          topicScore += pulse_score;

          let targetTopicId = topic.id;
          const isMovieKeyword = kw.toLowerCase().includes('movie') || kw.toLowerCase().includes('film');
          const isMovieGroup = ['bollywood_cinema', 'hollywood_cinema'].includes(topic.id) || isMovieKeyword;
          
          if (isMovieGroup && v.duration && v.duration.split(':').length === 3) {
            targetTopicId = 'full_movies';
          }

          newCurrentVideos.push({
            id: v.videoId,
            topic_id: targetTopicId,
            keyword: kw,
            title: v.title,
            channel_title: v.channelName,
            published_time: v.publishedText,
            duration: v.duration,
            thumbnail: v.thumbnail,
            views: currentViews,
            vph: vph,
            current_vph: current_vph,
            performance: pulse_score,
            created_at: created_at,
            last_seen: new Date().toISOString()
          });
        }
      }));
      
      processedKeywords += chunk.length;
      const pct = ((processedKeywords / totalKeywords) * 100).toFixed(1);
      console.log(`\n⏳ Progress: ${pct}% (${processedKeywords}/${totalKeywords})`);
      
      await new Promise(r => setTimeout(r, 100));
    }

    currentSnapshot.topics[topic.id] = {
      maxVPH: topicMaxVPH,
      totalScore: topicScore
    };
  }
  
  const dedupedVideos = [];
  const seenIds = new Set();
  
  // First, add all newly found videos
  for (const v of newCurrentVideos) {
      const uniqueKey = v.id + '_' + v.topic_id;
      if (!seenIds.has(uniqueKey)) {
          seenIds.add(uniqueKey);
          dedupedVideos.push(v);
      }
  }

  // Second, merge historical videos from cache so we don't lose them if they temporarily vanish from YouTube search!
  for (const oldV of videoCache.values()) {
      const uniqueKey = oldV.id + '_' + oldV.topic_id;
      if (!seenIds.has(uniqueKey)) {
          const hoursSinceSeen = (new Date() - new Date(oldV.last_seen)) / (1000 * 60 * 60);
          if (hoursSinceSeen < 48) { // Keep history for 48 hours
              seenIds.add(uniqueKey);
              if (oldV.current_vph === undefined) {
                  oldV.current_vph = oldV.change_30m || 0;
              }
              dedupedVideos.push(oldV);
          }
      }
  }

  const videosByTopic = {};
  for (const v of dedupedVideos) {
      if (!videosByTopic[v.topic_id]) videosByTopic[v.topic_id] = [];
      videosByTopic[v.topic_id].push(v);
  }

  let finalVideos = [];
  for (const topicId in videosByTopic) {
      videosByTopic[topicId].sort((a, b) => b.performance - a.performance);
      finalVideos = finalVideos.concat(videosByTopic[topicId]); // Keep ALL videos!
  }

  // Final global sort just for consistency
  finalVideos.sort((a, b) => b.performance - a.performance);
  masterData.current_videos = finalVideos;

  // 5. Append Historical Snapshot
  masterData.snapshots.push(currentSnapshot);
  if (masterData.snapshots.length > CRAWL_CONFIG.historySnapshotsLimit) {
    masterData.snapshots.shift(); // Remove oldest
  }

  // 6. Write locally
  fs.writeFileSync(dataPath, JSON.stringify(masterData, null, 2));
  console.log(`✅ Data written to ${dataPath}`);

  // 7. Generate lightweight TV feed
  const tvFeed = {};
  
  // Group videos by topic
  const groupedVideos = {};
  for (const v of masterData.current_videos) {
      if (!groupedVideos[v.topic_id]) groupedVideos[v.topic_id] = [];
      groupedVideos[v.topic_id].push(v);
  }

  for (const topic_id in groupedVideos) {
      const topicVids = groupedVideos[topic_id];
      const selectedVids = new Set();
      
      // Top 200 by current_vph
      const byCurrentVph = [...topicVids].sort((a, b) => (b.current_vph || 0) - (a.current_vph || 0));
      for (let i = 0; i < Math.min(200, byCurrentVph.length); i++) selectedVids.add(byCurrentVph[i]);
      
      // Top 200 by vph
      const byVph = [...topicVids].sort((a, b) => (b.vph || 0) - (a.vph || 0));
      for (let i = 0; i < Math.min(200, byVph.length); i++) selectedVids.add(byVph[i]);

      // Fill the rest up to 500 with top by performance
      const byPerf = [...topicVids].sort((a, b) => (b.performance || 0) - (a.performance || 0));
      for (let i = 0; selectedVids.size < 500 && i < byPerf.length; i++) selectedVids.add(byPerf[i]);
      
      tvFeed[topic_id] = Array.from(selectedVids).map(v => [
          v.id,
          v.title,
          v.channel_title,
          v.views,
          v.published_time,
          v.duration,
          Number((v.vph || 0).toFixed(1)),
          Number((v.performance || 0).toFixed(2)),
          Number((v.growth || 0).toFixed(2)),
          Number((v.current_vph || 0).toFixed(1))
      ]);
  }
  const tvFeedPath = path.join(__dirname, 'tv_feed.json');
  fs.writeFileSync(tvFeedPath, JSON.stringify(tvFeed));
  console.log(`✅ TV Feed written to ${tvFeedPath}`);
  
  console.log("Crawler execution complete.");
}

run().catch(e => {
  console.error("Crawler failed:", e);
  process.exit(1);
});
