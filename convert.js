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

const tvFeed = {};
for (const v of masterData.current_videos) {
    if (!tvFeed[v.topic_id]) {
        tvFeed[v.topic_id] = [];
    }
    if (tvFeed[v.topic_id].length < 500) { // Keep top 500 per topic for TV UI
        const ageHours = parseAgeTextToHours(v.published_time);
        const realVph = Number((v.views / ageHours).toFixed(1));
        
        tvFeed[v.topic_id].push([
            v.id,
            v.title,
            v.channel_title,
            v.views,
            v.published_time,
            v.duration,
            realVph,
            Number((v.performance || 0).toFixed(2)),
            Number((v.growth || 0).toFixed(2))
        ]);
    }
}

fs.writeFileSync(tvFeedPath, JSON.stringify(tvFeed));
console.log(`✅ TV Feed compressed and written. Size: ${fs.statSync(tvFeedPath).size} bytes`);
