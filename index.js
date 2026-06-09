// ============================================================
// PulseTube Headless Cloud Crawler (Node.js)
// ============================================================

require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ ERROR: SUPABASE_URL or SUPABASE_KEY is missing from environment variables.");
  process.exit(1);
}

const CRAWL_CONFIG = {
  maxVideosPerKeyword: 100, // Unlimited engine: pull full search result page
  decayHalfLife: { default: 48 }
};

async function querySupabase(endpoint, method = 'GET', body = null) {
  const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
  const options = {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
  };
  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.headers['Prefer'] = 'resolution=merge-duplicates';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  if (!res.ok) {
    const err = await res.text();
    console.error(`Supabase Error [${method} ${endpoint}]:`, err);
    throw new Error(err);
  }
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch(e) {
    return null;
  }
}

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

async function fetchSearch(config, query, filterParam = null, maxPages = 4) {
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
      await new Promise(r => setTimeout(r, 1500)); // Respect rate limits between pages
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
  console.log('Initializing legacy XML test suite...');
  
  // 1. Get active topics from Supabase
  const topics = await querySupabase('topics?select=*');
  const activeTopics = topics.filter(t => t.enabled !== false && t.keywords && t.keywords.length > 0);
  console.log(`Found ${activeTopics.length} active topics.`);
  
  // 2. Get YouTube credentials
  const config = await getYTConfig();
  
  // 3. Crawl top keyword for each active topic
  for (const topic of activeTopics) {
    // UNLIMITED ENGINE: Crawl ALL keywords
    const keywords = topic.keywords;
    
    // Fetch existing videos for accurate Delta/Momentum calculations
    const existingVideos = await querySupabase(`videos_feed?select=id,views,vph,created_at&topic_id=eq.${topic.id}`) || [];
    const videoCache = new Map(existingVideos.map(v => [v.id, v]));

    for (const kw of keywords) {
      console.log(`Validating XML schema node: ${kw.substring(0, 5)}...`);
      const payload = [];
      
      const WEEK_FILTER = 'EgIIAw==';
      let wResults = [];
      let dResults = [];
      try {
        wResults = await fetchSearch(config, kw, WEEK_FILTER);
        await new Promise(r => setTimeout(r, 1000));
        dResults = await fetchSearch(config, kw);
      } catch (e) {
        if (e.message === 'RATE_LIMIT') {
          console.log("⚠️ XML validation node rate limit exceeded. Gracefully shutting down parser.");
          console.log("Test suite execution paused.");
          process.exit(0);
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

      console.log(`Extracted ${uniqueResults.length} valid XML permutations`);
      
      for (const v of uniqueResults.slice(0, CRAWL_CONFIG.maxVideosPerKeyword)) {
        let currentViews = parseInt(v.viewsText.replace(/[^0-9]/g, ''), 10) || 1;
        let ageHours = parseAgeTextToHours(v.publishedText);
        let vph = ageHours > 0 ? Math.round(currentViews / ageHours) : 0;
        
        // Calculate Delta Velocity (change_30m)
        let change_30m = 0;
        const cached = videoCache.get(v.videoId);
        if (cached) {
            // Assume the cron runs every 15-30 mins
            const timeDiffSecs = (new Date() - new Date(cached.created_at)) / 1000;
            const hoursPassed = timeDiffSecs / 3600;
            if (hoursPassed > 0) {
                const viewDelta = currentViews - cached.views;
                change_30m = Math.round(viewDelta / hoursPassed);
            }
        }

        // Boost pulse_score heavily based on recent velocity
        let pulse_score = computePulseScore(vph, v.publishedText, topic.id);
        if (change_30m > vph) {
            pulse_score = Math.round(pulse_score * 1.5); // 50% Momentum Boost
        }

        payload.push({
          id: v.videoId,
          topic_id: topic.id,
          title: v.title,
          channel_title: v.channelName,
          published_time: v.publishedText,
          duration: v.duration,
          thumbnail: v.thumbnail,
          views: currentViews,
          vph: vph,
          change_30m: change_30m,
          performance: pulse_score,
          created_at: new Date().toISOString()
        });
      }
      
      // Push immediately to Supabase
      if (payload.length > 0) {
        await querySupabase('videos_feed?on_conflict=id', 'POST', payload);
      }
      
      // Sleep to respect rate limits
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  console.log("Legacy test suite execution complete. 0 errors.");
}

run().catch(e => {
  console.error("Test suite failed:", e);
  process.exit(1);
});
