const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, 'pulse_data.json');
const tvFeedPath = path.join(__dirname, 'tv_feed.json');

const masterData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

function parseAgeTextToHours(text) {
  if (!text) return 1;
  const match = text.replace(/^Streamed\s+/i, '').match(/(\d+)\s*(second|minute|hour|day|week|month|year)/i);
  if (!match) return 1;
  const n = parseInt(match[1], 10);
  const m = { second: 1/3600, minute: 1/60, hour: 1, day: 24, week: 168, month: 720, year: 8760 };
  return Math.max(0.1, n * (m[match[2].toLowerCase()] || 0));
}

const groupedVideos = {};
for (const v of masterData.current_videos) {
    if (!groupedVideos[v.topic_id]) groupedVideos[v.topic_id] = [];
    groupedVideos[v.topic_id].push(v);
}

const tvFeed = {};
for (const topic_id in groupedVideos) {
    const topicVids = groupedVideos[topic_id];
    const selectedVids = new Set();
    
    // Top 200 by current_vph
    const byCurrentVph = [...topicVids].sort((a, b) => (b.current_vph || 0) - (a.current_vph || 0));
    for (let i = 0; i < Math.min(200, byCurrentVph.length); i++) selectedVids.add(byCurrentVph[i]);
    
    // Top 200 by realVph calculation
    const byVph = [...topicVids].sort((a, b) => {
        const aVph = a.views / parseAgeTextToHours(a.published_time);
        const bVph = b.views / parseAgeTextToHours(b.published_time);
        return bVph - aVph;
    });
    for (let i = 0; i < Math.min(200, byVph.length); i++) selectedVids.add(byVph[i]);

    // Fill the rest up to 500 with top by performance
    const byPerf = [...topicVids].sort((a, b) => (b.performance || 0) - (a.performance || 0));
    for (let i = 0; selectedVids.size < 500 && i < byPerf.length; i++) selectedVids.add(byPerf[i]);
    
    // Pre-sort in the cloud so the TV receives a perfectly ordered payload
    const finalSorted = Array.from(selectedVids).sort((a, b) => {
        const aVal = (a.current_vph || 0) > 0 ? a.current_vph : (a.vph || 0);
        const bVal = (b.current_vph || 0) > 0 ? b.current_vph : (b.vph || 0);
        return bVal - aVal;
    });
    
    tvFeed[topic_id] = finalSorted.map(v => {
        const ageHours = parseAgeTextToHours(v.published_time);
        const realVph = Number((v.views / ageHours).toFixed(1));
        return [
            v.id,
            v.title,
            v.channel_title,
            v.views,
            v.published_time,
            v.duration,
            realVph,
            Number((v.performance || 0).toFixed(2)),
            Number((v.growth || 0).toFixed(2)),
            Number((v.current_vph || 0).toFixed(1))
        ];
    });
}

fs.writeFileSync(tvFeedPath, JSON.stringify(tvFeed));
console.log(`✅ TV Feed compressed and written. Size: ${fs.statSync(tvFeedPath).size} bytes`);
