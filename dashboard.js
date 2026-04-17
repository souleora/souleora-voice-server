/**
 * Souleora Admin Dashboard — API Routes
 * Provides call monitoring, caller profiles, analytics
 */

import fs from 'fs';
import path from 'path';

export function mountDashboardRoutes(app, memoryEngine, dirs) {

  // ===== DASHBOARD HOME =====
  app.get('/dashboard', (req, res) => {
    res.send(getDashboardHTML());
  });

  // ===== API: Overview Stats =====
  app.get('/api/dashboard/stats', (req, res) => {
    const stats = memoryEngine.getStats();
    const transcripts = fs.readdirSync(dirs.transcripts).filter(f => f.endsWith('.json'));
    
    // Revenue estimate (based on call duration and pricing)
    const totalMinutes = stats.totalMinutes;
    const estimatedRevenue = totalMinutes * 2.99; // $2.99/min default

    res.json({
      ...stats,
      estimatedRevenue: estimatedRevenue.toFixed(2),
      activeToday: transcripts.filter(f => {
        try {
          const t = JSON.parse(fs.readFileSync(path.join(dirs.transcripts, f), 'utf8'));
          const callDate = new Date(t.timestamp);
          const today = new Date();
          return callDate.toDateString() === today.toDateString();
        } catch { return false; }
      }).length
    });
  });

  // ===== API: Recent Calls =====
  app.get('/api/dashboard/calls', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const transcripts = fs.readdirSync(dirs.transcripts)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dirs.transcripts, f), 'utf8'));
          return {
            callId: data.callId,
            timestamp: data.timestamp,
            duration: data.duration,
            callerNumber: data.callerNumber,
            summary: data.summary || 'No summary available'
          };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);

    res.json(transcripts);
  });

  // ===== API: Caller Profiles =====
  app.get('/api/dashboard/callers', (req, res) => {
    const callerFiles = fs.readdirSync(dirs.callers).filter(f => f.endsWith('.json'));
    const callers = callerFiles.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dirs.callers, f), 'utf8'));
        return {
          phoneNumber: data.phoneNumber,
          name: data.name || 'Unknown',
          totalCalls: data.totalCalls,
          totalMinutes: Math.round(data.totalMinutes),
          firstCall: data.firstCall,
          lastCall: data.lastCall,
          birthData: data.birthData ? 'On file' : 'Missing',
          dominantEmotion: data.emotionalProfile?.dominantEmotion || 'Unknown',
          topics: data.topics?.slice(0, 5) || []
        };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.totalCalls - a.totalCalls);

    res.json(callers);
  });

  // ===== API: Single Caller Detail =====
  app.get('/api/dashboard/callers/:phone', (req, res) => {
    const profile = memoryEngine.getCallerProfile(req.params.phone);
    if (profile) {
      res.json(profile);
    } else {
      res.status(404).json({ error: 'Caller not found' });
    }
  });

  // ===== API: Call Transcript =====
  app.get('/api/dashboard/calls/:callId', (req, res) => {
    const file = path.join(dirs.transcripts, `${req.params.callId}.json`);
    if (fs.existsSync(file)) {
      res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
    } else {
      res.status(404).json({ error: 'Call not found' });
    }
  });

  // ===== API: Global Learning Data =====
  app.get('/api/dashboard/learning', (req, res) => {
    try {
      const global = JSON.parse(fs.readFileSync(path.join(dirs.memory, 'global-memory.json'), 'utf8'));
      const slang = JSON.parse(fs.readFileSync(path.join(dirs.memory, 'slang-dictionary.json'), 'utf8'));
      const emotions = JSON.parse(fs.readFileSync(path.join(dirs.memory, 'emotion-patterns.json'), 'utf8'));

      res.json({
        globalMemory: global,
        slangDictionary: slang.learned.sort((a, b) => b.frequency - a.frequency).slice(0, 50),
        emotionPatterns: Object.keys(emotions.patterns),
        promptVersions: fs.readdirSync(dirs.promptVersions).filter(f => f.endsWith('.md')).length
      });
    } catch (e) {
      res.json({ error: e.message });
    }
  });

  // ===== API: Trigger Prompt Evolution =====
  app.post('/api/dashboard/evolve', async (req, res) => {
    // Proxy to the existing evolve endpoint
    try {
      const response = await fetch('http://localhost:3003/api/evolve-prompt', { method: 'POST' });
      const data = await response.json();
      res.json(data);
    } catch (e) {
      res.json({ error: e.message });
    }
  });
}

// ===== DASHBOARD HTML =====
function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Souleora Admin — Voice Agent Dashboard</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
  
  :root {
    --bg: #0f1117;
    --card: #1a1d27;
    --border: #2a2d3a;
    --gold: #d4a853;
    --green: #4ade80;
    --red: #ef4444;
    --blue: #60a5fa;
    --purple: #a78bfa;
    --text: #e2e8f0;
    --muted: #94a3b8;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: var(--bg); color: var(--text); font-family: 'Inter', sans-serif; font-size: 14px; }

  .header {
    padding: 20px 30px;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .header h1 { font-size: 20px; font-weight: 600; color: var(--gold); }
  .header .status { display: flex; gap: 15px; align-items: center; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); display: inline-block; }

  .container { padding: 25px 30px; }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 15px;
    margin-bottom: 25px;
  }

  .stat-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 18px 20px;
  }
  .stat-card .label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); margin-bottom: 8px; }
  .stat-card .value { font-size: 28px; font-weight: 700; color: var(--text); }
  .stat-card .value.gold { color: var(--gold); }
  .stat-card .value.green { color: var(--green); }

  .panels { display: grid; grid-template-columns: 2fr 1fr; gap: 20px; }

  .panel {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  .panel-header {
    padding: 15px 20px;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .panel-body { padding: 15px 20px; max-height: 500px; overflow-y: auto; }

  .call-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 0;
    border-bottom: 1px solid rgba(255,255,255,0.05);
    cursor: pointer;
    transition: background 0.2s;
  }
  .call-row:hover { background: rgba(212,168,83,0.05); margin: 0 -20px; padding: 12px 20px; }
  .call-row .caller { font-weight: 500; }
  .call-row .meta { color: var(--muted); font-size: 12px; }
  .call-row .duration { color: var(--gold); font-weight: 600; }

  .caller-card {
    padding: 12px 0;
    border-bottom: 1px solid rgba(255,255,255,0.05);
  }
  .caller-card .name { font-weight: 600; color: var(--gold); }
  .caller-card .details { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .caller-card .emotion { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; background: rgba(167,139,250,0.15); color: var(--purple); margin-top: 4px; }

  .btn {
    padding: 8px 16px;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    transition: all 0.2s;
  }
  .btn-gold { background: var(--gold); color: #000; }
  .btn-gold:hover { opacity: 0.9; }

  .refresh-time { font-size: 11px; color: var(--muted); }

  @media (max-width: 900px) {
    .stats-grid { grid-template-columns: repeat(3, 1fr); }
    .panels { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>

<div class="header">
  <h1>🔮 Souleora Voice Agent — Dashboard</h1>
  <div class="status">
    <span class="refresh-time" id="refreshTime">Loading...</span>
    <span><span class="status-dot"></span> Luna Online</span>
    <button class="btn btn-gold" onclick="location.reload()">Refresh</button>
  </div>
</div>

<div class="container">
  <!-- Stats Cards -->
  <div class="stats-grid" id="statsGrid">
    <div class="stat-card"><div class="label">Total Calls</div><div class="value" id="totalCalls">—</div></div>
    <div class="stat-card"><div class="label">Total Minutes</div><div class="value" id="totalMinutes">—</div></div>
    <div class="stat-card"><div class="label">Unique Callers</div><div class="value" id="uniqueCallers">—</div></div>
    <div class="stat-card"><div class="label">Return Rate</div><div class="value green" id="returnRate">—</div></div>
    <div class="stat-card"><div class="label">Avg Satisfaction</div><div class="value gold" id="avgSatisfaction">—</div></div>
    <div class="stat-card"><div class="label">Est. Revenue</div><div class="value green" id="revenue">—</div></div>
  </div>

  <!-- Main Panels -->
  <div class="panels">
    <div class="panel">
      <div class="panel-header">
        <span>Recent Calls</span>
        <span class="refresh-time" id="callCount">0 calls</span>
      </div>
      <div class="panel-body" id="callsList">
        <p style="color: var(--muted)">No calls yet. Luna is waiting for her first reading...</p>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header">
        <span>Caller Profiles</span>
        <span class="refresh-time" id="callerCount">0 callers</span>
      </div>
      <div class="panel-body" id="callersList">
        <p style="color: var(--muted)">No caller profiles yet.</p>
      </div>
    </div>
  </div>
</div>

<script>
async function loadDashboard() {
  try {
    // Load stats
    const stats = await fetch('/api/dashboard/stats').then(r => r.json());
    document.getElementById('totalCalls').textContent = stats.totalCalls || 0;
    document.getElementById('totalMinutes').textContent = stats.totalMinutes || 0;
    document.getElementById('uniqueCallers').textContent = stats.uniqueCallers || 0;
    document.getElementById('returnRate').textContent = (stats.returnRate || 0) + '%';
    document.getElementById('avgSatisfaction').textContent = stats.averageSatisfaction || 'N/A';
    document.getElementById('revenue').textContent = '$' + (stats.estimatedRevenue || '0.00');
    document.getElementById('refreshTime').textContent = 'Updated: ' + new Date().toLocaleTimeString();

    // Load recent calls
    const calls = await fetch('/api/dashboard/calls?limit=20').then(r => r.json());
    document.getElementById('callCount').textContent = calls.length + ' calls';
    if (calls.length > 0) {
      document.getElementById('callsList').innerHTML = calls.map(c => {
        const date = new Date(c.timestamp).toLocaleString();
        const mins = Math.round((c.duration || 0) / 60);
        return '<div class="call-row">' +
          '<div><div class="caller">' + (c.callerNumber || 'Unknown') + '</div>' +
          '<div class="meta">' + date + '</div></div>' +
          '<div class="duration">' + mins + ' min</div></div>';
      }).join('');
    }

    // Load callers
    const callers = await fetch('/api/dashboard/callers').then(r => r.json());
    document.getElementById('callerCount').textContent = callers.length + ' callers';
    if (callers.length > 0) {
      document.getElementById('callersList').innerHTML = callers.map(c => {
        return '<div class="caller-card">' +
          '<div class="name">' + c.name + '</div>' +
          '<div class="details">' + c.totalCalls + ' calls · ' + c.totalMinutes + ' min · ' + c.phoneNumber + '</div>' +
          (c.dominantEmotion !== 'Unknown' ? '<span class="emotion">' + c.dominantEmotion + '</span>' : '') +
          '</div>';
      }).join('');
    }

  } catch (e) {
    console.error('Dashboard load error:', e);
  }
}

loadDashboard();
setInterval(loadDashboard, 30000); // Auto-refresh every 30s
</script>

</body>
</html>`;
}
