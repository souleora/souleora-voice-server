import express from 'express';
import cors from 'cors';
import fs from 'fs';
import { MemoryEngine } from './memory-engine.js';
import { mountDashboardRoutes } from './dashboard.js';
import { mountSchedulerRoutes } from './scheduler.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Try loading .env for local dev; Railway injects env vars directly
try { dotenv.config({ path: path.join(__dirname, '../../.env') }); } catch {}
try { dotenv.config(); } catch {}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || process.env.VOICE_SERVER_PORT || 3003;
const ASTRO_USER = process.env.ASTROLOGY_API_USER_ID;
const ASTRO_KEY = process.env.ASTROLOGY_API_KEY;

console.log(`[Config] ASTRO_USER: ${ASTRO_USER ? 'set' : 'MISSING'}, ASTRO_KEY: ${ASTRO_KEY ? ASTRO_KEY.substring(0,8)+'...' : 'MISSING'}`);
const TRANSCRIPTS_DIR = path.join(__dirname, '../transcripts');
const ANALYSIS_DIR = path.join(__dirname, '../analysis');
const PROFILES_DIR = path.join(__dirname, '../caller-profiles');
const LEARNINGS_FILE = path.join(__dirname, '../memory/voice-learnings.md');
const PROMPT_VERSIONS_DIR = path.join(__dirname, '../prompt-versions');

const MEMORY_DIR = path.join(__dirname, '../memory');
const CALLERS_DIR = path.join(MEMORY_DIR, 'callers');

// Ensure directories exist
[TRANSCRIPTS_DIR, ANALYSIS_DIR, PROFILES_DIR, MEMORY_DIR, CALLERS_DIR, PROMPT_VERSIONS_DIR].forEach(dir => {
  fs.mkdirSync(dir, { recursive: true });
});

// Initialize memory engine
const memory = new MemoryEngine(MEMORY_DIR);

// Mount dashboard routes
mountDashboardRoutes(app, memory, {
  transcripts: TRANSCRIPTS_DIR,
  analysis: ANALYSIS_DIR,
  callers: CALLERS_DIR,
  memory: MEMORY_DIR,
  promptVersions: PROMPT_VERSIONS_DIR
});

// ===== GEOCODING (city → lat/lon/tz) =====
async function geocodeCity(city, country = '') {
  try {
    // Use city name only — adding country breaks the API
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=5&language=en`);
    const data = await res.json();
    if (data.results && data.results.length > 0) {
      // Prefer matching country if provided
      let r = data.results[0];
      if (country) {
        const countryUpper = country.toUpperCase();
        const match = data.results.find(x => x.country_code === countryUpper || (x.country || '').toUpperCase().includes(countryUpper));
        if (match) r = match;
      }
      return {
        lat: r.latitude,
        lon: r.longitude,
        timezone: r.timezone,
        tzOffset: getTimezoneOffset(r.timezone),
        name: r.name,
        country: r.country
      };
    }
    return null;
  } catch (e) {
    console.error('Geocode error:', e.message);
    return null;
  }
}

function getTimezoneOffset(tz) {
  try {
    const now = new Date();
    const utcDate = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
    const tzDate = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    return (tzDate - utcDate) / 3600000;
  } catch {
    return -7; // default MST
  }
}

// ===== ASTROLOGY API CALLS =====
import { execSync } from 'child_process';

const ASTRO_PROXY_URL = process.env.ASTRO_PROXY_URL;

async function astroCall(endpoint, body) {
  // Strategy: Use Cloudflare proxy (Mac mini) if available, then direct curl, then fetch
  
  // Method 1: Proxy through Mac mini (most reliable)
  if (ASTRO_PROXY_URL) {
    try {
      const url = `${ASTRO_PROXY_URL}/astro/${endpoint}`;
      console.log(`[AstroAPI] Using proxy: ${url}`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.planets || data.prediction) {
        console.log(`[AstroAPI] Proxy success: planets=${data.planets?.length || '?'}`);
        return data;
      }
      if (data.error) throw new Error(data.error);
    } catch (e) {
      console.log(`[AstroAPI] Proxy failed: ${e.message}, trying fallbacks...`);
    }
  }

  // Method 2: Direct curl (works locally)
  try {
    const cmd = `curl -s -X POST "https://json.astrologyapi.com/v1/${endpoint}" -u "${ASTRO_USER}:${ASTRO_KEY}" -H "Content-Type: application/json" -d '${JSON.stringify(body)}'`;
    const result = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
    const data = JSON.parse(result);
    if (data.planets || data.prediction) {
      console.log(`[AstroAPI] Curl success: planets=${data.planets?.length || '?'}`);
      return data;
    }
  } catch (e) {
    console.log(`[AstroAPI] Curl failed: ${e.message}`);
  }

  // Method 3: Native fetch (may fail on some cloud providers)
  try {
    const auth = Buffer.from(`${ASTRO_USER}:${ASTRO_KEY}`).toString('base64');
    const res = await fetch(`https://json.astrologyapi.com/v1/${endpoint}`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!data.errorType) return data;
  } catch (e) {
    console.log(`[AstroAPI] Fetch failed: ${e.message}`);
  }

  return { error: 'All AstrologyAPI methods failed' };
}

async function getFullBirthChart(day, month, year, hour, min, lat, lon, tzone) {
  // Round coordinates to 3 decimal places — AstrologyAPI is sensitive to precision
  const body = { 
    day: parseInt(day), month: parseInt(month), year: parseInt(year), 
    hour: parseInt(hour), min: parseInt(min), 
    lat: Math.round(lat * 1000) / 1000, 
    lon: Math.round(lon * 1000) / 1000, 
    tzone: parseFloat(tzone) 
  };
  console.log('[AstroAPI] Request body:', JSON.stringify(body));
  
  const [chart, aspects] = await Promise.all([
    astroCall('western_horoscope', body),
    // Aspects are included in western_horoscope response
    Promise.resolve(null)
  ]);

  return {
    planets: chart.planets,
    houses: chart.houses,
    ascendant: chart.ascendant,
    midheaven: chart.midheaven,
    aspects: chart.aspects,
    lilith: chart.lilith
  };
}

// ===== VAPI FUNCTION CALLING ENDPOINT =====
// This is what Vapi calls when Luna needs astrology data mid-conversation
app.post('/api/function-call', async (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message || !message.functionCall) {
      return res.json({ result: 'No function call provided' });
    }

    const { name, parameters } = message.functionCall;
    console.log(`[Function Call] ${name}`, JSON.stringify(parameters).substring(0, 200));

    let result;

    switch (name) {
      case 'get_birth_chart': {
        const { day, month, year, hour = 12, min = 0, city, country = '' } = parameters;
        
        // Geocode the city
        const geo = await geocodeCity(city, country);
        if (!geo) {
          result = { error: `Could not find location: ${city}` };
          break;
        }

        // Get the chart
        const chart = await getFullBirthChart(day, month, year, hour, min, geo.lat, geo.lon, geo.tzOffset);
        
        // Format for Luna to speak naturally
        const formatted = formatChartForSpeaking(chart);
        result = formatted;
        break;
      }

      case 'get_current_transits': {
        const { day, month, year, hour = 12, min = 0, lat, lon, tzone } = parameters;
        const now = new Date();
        const transitBody = {
          day, month, year, hour, min, lat, lon, tzone,
          transit_day: now.getDate(),
          transit_month: now.getMonth() + 1,
          transit_year: now.getFullYear(),
          transit_hour: now.getHours(),
          transit_min: now.getMinutes()
        };
        
        try {
          const transits = await astroCall('western_horoscope/transits', transitBody);
          result = transits;
        } catch (e) {
          // Fallback - get current planetary positions
          const currentChart = await astroCall('western_horoscope', {
            day: now.getDate(), month: now.getMonth() + 1, year: now.getFullYear(),
            hour: now.getHours(), min: now.getMinutes(), lat, lon, tzone
          });
          result = { currentPlanets: currentChart.planets, note: 'Current planetary positions for transit comparison' };
        }
        break;
      }

      case 'get_compatibility': {
        const p = parameters;
        // Geocode if needed, use defaults
        const body = {
          day: p.person1_day, month: p.person1_month, year: p.person1_year,
          hour: p.person1_hour || 12, min: p.person1_min || 0,
          lat: p.person1_lat || 33.45, lon: p.person1_lon || -112.07, tzone: p.person1_tzone || -7,
          p_day: p.person2_day, p_month: p.person2_month, p_year: p.person2_year,
          p_hour: p.person2_hour || 12, p_min: p.person2_min || 0,
          p_lat: p.person2_lat || 33.45, p_lon: p.person2_lon || -112.07, p_tzone: p.person2_tzone || -7
        };
        const synastry = await astroCall('western_horoscope/synastry', body);
        result = synastry;
        break;
      }

      case 'geocode_city': {
        const geo = await geocodeCity(parameters.city, parameters.country);
        result = geo || { error: 'City not found' };
        break;
      }

      case 'save_call_memory': {
        const { caller_name, key_insights, questions_asked, follow_up_notes } = parameters;
        const profileFile = path.join(PROFILES_DIR, `${caller_name.toLowerCase().replace(/\s+/g, '-')}.json`);
        
        let profile = {};
        if (fs.existsSync(profileFile)) {
          profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
        }

        profile.name = caller_name;
        profile.lastCall = new Date().toISOString();
        profile.callCount = (profile.callCount || 0) + 1;
        if (!profile.readings) profile.readings = [];
        profile.readings.push({
          date: new Date().toISOString(),
          insights: key_insights,
          questions: questions_asked,
          followUp: follow_up_notes
        });

        fs.writeFileSync(profileFile, JSON.stringify(profile, null, 2));
        result = { saved: true, callCount: profile.callCount };
        break;
      }

      default:
        result = { error: `Unknown function: ${name}` };
    }

    console.log(`[Function Result] ${name}: ${JSON.stringify(result).substring(0, 200)}`);
    res.json({ result: JSON.stringify(result) });

  } catch (error) {
    console.error('[Function Call Error]', error);
    res.json({ result: JSON.stringify({ error: error.message }) });
  }
});

// ===== FORMAT CHART DATA FOR NATURAL SPEAKING =====
function formatChartForSpeaking(chart) {
  if (!chart || !chart.planets) return { error: 'No chart data' };

  const signs = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo','Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];
  
  let summary = {
    bigThree: {},
    planets: [],
    keyAspects: [],
    houses: chart.houses
  };

  // Extract Big Three
  for (const p of chart.planets) {
    const degree = Math.floor(p.norm_degree);
    const entry = {
      name: p.name,
      sign: p.sign,
      degree: degree,
      house: p.house,
      retrograde: p.is_retro === 'true'
    };

    if (p.name === 'Sun') summary.bigThree.sun = entry;
    else if (p.name === 'Moon') summary.bigThree.moon = entry;
    
    summary.planets.push(entry);
  }

  // Rising sign from ascendant
  if (chart.ascendant) {
    const ascDeg = chart.ascendant;
    const ascSignIdx = Math.floor(ascDeg / 30);
    summary.bigThree.rising = {
      sign: signs[ascSignIdx] || 'Unknown',
      degree: Math.floor(ascDeg % 30)
    };
  }

  // Midheaven
  if (chart.midheaven) {
    const mcDeg = chart.midheaven;
    const mcSignIdx = Math.floor(mcDeg / 30);
    summary.midheaven = {
      sign: signs[mcSignIdx] || 'Unknown',
      degree: Math.floor(mcDeg % 30)
    };
  }

  // Key aspects (tight orbs only — most important)
  if (chart.aspects) {
    summary.keyAspects = chart.aspects
      .filter(a => a.orb <= 5)
      .sort((a, b) => a.orb - b.orb)
      .slice(0, 8)
      .map(a => ({
        planet1: a.aspecting_planet,
        planet2: a.aspected_planet,
        type: a.type,
        orb: a.orb
      }));
  }

  // Create a natural language summary for Luna
  const sun = summary.bigThree.sun;
  const moon = summary.bigThree.moon;
  const rising = summary.bigThree.rising;

  summary.speakingNotes = `
This person's Big Three: Sun in ${sun?.sign || '?'} at ${sun?.degree || '?'} degrees in the ${sun?.house || '?'}th house. 
Moon in ${moon?.sign || '?'} at ${moon?.degree || '?'} degrees in the ${moon?.house || '?'}th house. 
Rising sign is ${rising?.sign || '?'} at ${rising?.degree || '?'} degrees.
Midheaven in ${summary.midheaven?.sign || '?'}.

Key aspects to mention: ${summary.keyAspects.map(a => `${a.planet1} ${a.type} ${a.planet2} (${a.orb}° orb)`).join(', ')}.

Retrograde planets: ${summary.planets.filter(p => p.retrograde).map(p => p.name).join(', ') || 'None'}.
  `.trim();

  return summary;
}

// ===== VAPI WEBHOOK — POST-CALL PROCESSING =====
app.post('/api/webhook', async (req, res) => {
  try {
    const event = req.body;
    const eventType = event.message?.type || event.type || 'unknown';
    
    console.log(`[Webhook] Event: ${eventType}`);

    if (eventType === 'end-of-call-report') {
      const report = event.message || event;
      const callId = report.call?.id || `call-${Date.now()}`;
      const transcript = report.transcript || report.artifact?.transcript || '';
      const summary = report.summary || report.analysis?.summary || '';
      const duration = report.call?.duration || report.durationSeconds || 0;
      const callerNumber = report.call?.customer?.number || report.customer?.number || 'unknown';
      const callerName = report.call?.customer?.name || 'unknown';
      
      // Save raw transcript
      const transcriptFile = path.join(TRANSCRIPTS_DIR, `${callId}.json`);
      fs.writeFileSync(transcriptFile, JSON.stringify({
        callId,
        timestamp: new Date().toISOString(),
        duration,
        callerNumber,
        callerName,
        transcript,
        summary,
        rawReport: report
      }, null, 2));

      console.log(`[Webhook] Saved transcript: ${callId} (${duration}s) from ${callerNumber}`);

      // Detect emotions from transcript
      const emotions = memory.detectEmotions(transcript);
      console.log(`[Emotions] Detected: ${emotions.map(e => e.emotion).join(', ') || 'none'}`);

      // Update per-caller memory
      if (callerNumber !== 'unknown') {
        memory.createOrUpdateCaller(callerNumber, {
          name: callerName,
          duration,
          callSummary: summary,
          topics: extractTopicsFromTranscript(transcript),
          emotions: emotions.map(e => e.emotion),
          satisfaction: report.analysis?.successEvaluation ? parseSatisfaction(report.analysis.successEvaluation) : null
        });
        console.log(`[Memory] Updated caller profile: ${callerNumber}`);
      }

      // Update global learning memory
      memory.updateGlobalMemory({
        duration,
        topics: extractTopicsFromTranscript(transcript),
        satisfaction: report.analysis?.successEvaluation ? parseSatisfaction(report.analysis.successEvaluation) : null,
        slang: extractSlangFromTranscript(transcript)
      });

      // Run async deep analysis
      analyzeCall(callId, transcript, summary, duration).catch(e => 
        console.error('[Analysis Error]', e.message)
      );
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('[Webhook Error]', error);
    res.json({ ok: true }); // Always 200 so Vapi doesn't retry
  }
});

// ===== CALL ANALYSIS ENGINE =====
async function analyzeCall(callId, transcript, summary, duration) {
  if (!transcript || transcript.length < 50) return;

  const analysisPrompt = `Analyze this astrology reading call transcript. Extract the following:

1. CALLER_LANGUAGE: List any slang, casual expressions, or unique phrases the caller used. These help us match their communication style.
2. TOPICS_REQUESTED: What specific areas did they ask about? (love, career, money, family, timing, etc.)
3. ENGAGEMENT_PEAKS: Moments where the caller seemed most engaged (asked follow-ups, expressed excitement, said "wow", "that's so true", etc.)
4. ENGAGEMENT_DROPS: Moments where the caller seemed disengaged (short responses, silence, changed subject)
5. LUNA_BEST_MOMENTS: What Luna said that got the best reactions
6. LUNA_WEAK_MOMENTS: Where Luna could have done better
7. IMPROVEMENT_SUGGESTIONS: Specific changes to make Luna better based on this call
8. CALLER_SATISFACTION: Rate 1-10 based on engagement signals
9. MEMORABLE_QUOTES: Any great lines from either side worth remembering
10. DEMOGRAPHIC_SIGNALS: Age range, personality type, astrology knowledge level

Transcript:
${typeof transcript === 'string' ? transcript : JSON.stringify(transcript)}

Respond in JSON format.`;

  try {
    // Use Anthropic API directly for analysis
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      console.log('[Analysis] No Anthropic API key — saving raw transcript only');
      return;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: analysisPrompt }]
      })
    });

    const result = await response.json();
    const analysisText = result.content?.[0]?.text || '';

    // Save analysis
    const analysisFile = path.join(ANALYSIS_DIR, `${callId}-analysis.json`);
    fs.writeFileSync(analysisFile, JSON.stringify({
      callId,
      timestamp: new Date().toISOString(),
      duration,
      analysis: analysisText
    }, null, 2));

    // Append learnings to the cumulative file
    const learningEntry = `\n## Call ${callId} — ${new Date().toISOString()}\nDuration: ${duration}s\n\n${analysisText}\n\n---\n`;
    fs.appendFileSync(LEARNINGS_FILE, learningEntry);

    console.log(`[Analysis] Completed for call ${callId}`);

  } catch (e) {
    console.error('[Analysis] Failed:', e.message);
  }
}

// ===== WEEKLY PROMPT EVOLUTION ENDPOINT =====
// Call this manually or via cron to evolve Luna's prompt
app.post('/api/evolve-prompt', async (req, res) => {
  try {
    // Read all analyses
    const analyses = fs.readdirSync(ANALYSIS_DIR)
      .filter(f => f.endsWith('-analysis.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(ANALYSIS_DIR, f), 'utf8')); }
        catch { return null; }
      })
      .filter(Boolean);

    if (analyses.length < 5) {
      return res.json({ message: 'Need at least 5 analyzed calls before evolving prompt', currentCalls: analyses.length });
    }

    // Read current prompt
    const currentPrompt = fs.readFileSync(path.join(__dirname, '../system-prompt.md'), 'utf8');

    const evolveRequest = `You are an AI prompt engineer. Based on ${analyses.length} analyzed calls, suggest specific improvements to this astrology voice agent's system prompt.

CURRENT PROMPT:
${currentPrompt}

CALL ANALYSES (last ${Math.min(analyses.length, 20)}):
${analyses.slice(-20).map(a => a.analysis).join('\n\n---\n\n')}

INSTRUCTIONS:
1. Identify patterns in caller language and incorporate natural slang/phrases Luna should use
2. Add pre-built responses for the most common questions
3. Adjust tone/pacing based on engagement data
4. Add any sign-specific speaking adjustments you notice
5. Remove or rephrase anything that consistently gets poor engagement

Output the COMPLETE updated system prompt (not just the changes). Mark new additions with [NEW] comments.`;

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      return res.json({ error: 'No Anthropic API key for prompt evolution' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        messages: [{ role: 'user', content: evolveRequest }]
      })
    });

    const result = await response.json();
    const newPrompt = result.content?.[0]?.text || '';

    // Save versioned prompt
    const version = fs.readdirSync(PROMPT_VERSIONS_DIR).length + 1;
    const versionFile = path.join(PROMPT_VERSIONS_DIR, `v${version}.md`);
    fs.writeFileSync(versionFile, newPrompt);

    res.json({
      message: `Prompt evolved to v${version}`,
      basedOnCalls: analyses.length,
      versionFile,
      preview: newPrompt.substring(0, 500) + '...'
    });

  } catch (error) {
    console.error('[Evolve Error]', error);
    res.json({ error: error.message });
  }
});

// ===== STATS ENDPOINT =====
app.get('/api/stats', (req, res) => {
  const transcripts = fs.readdirSync(TRANSCRIPTS_DIR).filter(f => f.endsWith('.json'));
  const analyses = fs.readdirSync(ANALYSIS_DIR).filter(f => f.endsWith('.json'));
  const profiles = fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith('.json'));
  const versions = fs.readdirSync(PROMPT_VERSIONS_DIR).filter(f => f.endsWith('.md'));

  res.json({
    totalCalls: transcripts.length,
    analyzedCalls: analyses.length,
    uniqueCallers: profiles.length,
    promptVersions: versions.length,
    currentVersion: versions.length > 0 ? `v${versions.length}` : 'v1.0 (base)',
    serverUptime: process.uptime()
  });
});


// ===== TEST ROUTE =====
app.get('/api/test-scheduler', (req, res) => {
  res.json({ scheduler: 'reachable', time: new Date().toISOString() });
});

// ===== MOUNT SCHEDULER =====
try {
  mountSchedulerRoutes(app);
  console.log('[Scheduler] Routes mounted successfully');
} catch (e) {
  console.error('[Scheduler] Failed to mount:', e.message);
}

// ===== HEALTH CHECK =====
app.get('/', (req, res) => {
  res.json({ 
    service: 'Souleora Voice Agent Server',
    status: 'running',
    version: '1.0.0',
    endpoints: {
      functionCall: 'POST /api/function-call',
      webhook: 'POST /api/webhook',
      evolvePrompt: 'POST /api/evolve-prompt',
      stats: 'GET /api/stats'
    }
  });
});

// ===== HELPER FUNCTIONS =====
function extractTopicsFromTranscript(transcript) {
  const text = typeof transcript === 'string' ? transcript.toLowerCase() : JSON.stringify(transcript).toLowerCase();
  const topicKeywords = {
    'love': ['love', 'relationship', 'partner', 'dating', 'marriage', 'boyfriend', 'girlfriend', 'husband', 'wife', 'soulmate', 'crush', 'ex'],
    'career': ['career', 'job', 'work', 'business', 'money', 'promotion', 'boss', 'salary', 'quit', 'fired'],
    'family': ['family', 'mother', 'father', 'parents', 'children', 'kids', 'sibling', 'brother', 'sister'],
    'health': ['health', 'sick', 'anxiety', 'depression', 'energy', 'tired', 'stress', 'wellness'],
    'timing': ['when', 'timing', 'this month', 'this year', 'next year', 'future', 'prediction'],
    'compatibility': ['compatible', 'compatibility', 'synastry', 'match', 'together'],
    'spirituality': ['spiritual', 'purpose', 'soul', 'karma', 'past life', 'meditation', 'energy'],
    'money': ['money', 'finances', 'wealth', 'investment', 'income', 'debt']
  };

  const found = [];
  for (const [topic, keywords] of Object.entries(topicKeywords)) {
    if (keywords.some(k => text.includes(k))) found.push(topic);
  }
  return found;
}

function extractSlangFromTranscript(transcript) {
  const text = typeof transcript === 'string' ? transcript.toLowerCase() : JSON.stringify(transcript).toLowerCase();
  const slangPhrases = [
    'no cap', 'fr fr', 'lowkey', 'highkey', 'deadass', 'periodt', 'slay', 'its giving',
    'bet', 'vibes', 'vibe check', 'on god', 'bussin', 'fire', 'lit', 'fam',
    'sus', 'tea', 'spill', 'iconic', 'manifesting', 'universe', 'aligned',
    'energy', 'toxic', 'red flag', 'green flag', 'ick', 'situationship'
  ];

  return slangPhrases
    .filter(s => text.includes(s))
    .map(s => ({ phrase: s, meaning: '' }));
}

function parseSatisfaction(evaluation) {
  if (typeof evaluation === 'number') return evaluation;
  const text = String(evaluation).toLowerCase();
  if (text.includes('excellent') || text.includes('10')) return 10;
  if (text.includes('great') || text.includes('9')) return 9;
  if (text.includes('good') || text.includes('8')) return 8;
  if (text.includes('satisf') || text.includes('7')) return 7;
  if (text.includes('ok') || text.includes('6')) return 6;
  if (text.includes('poor') || text.includes('5')) return 5;
  return 7; // default
}

// ===== START =====
app.listen(PORT, () => {
  console.log(`\n🔮 Souleora Voice Server running on port ${PORT}`);
  console.log(`   Function calls: http://localhost:${PORT}/api/function-call`);
  console.log(`   Webhook:        http://localhost:${PORT}/api/webhook`);
  console.log(`   Stats:          http://localhost:${PORT}/api/stats`);
  console.log(`   Prompt evolve:  http://localhost:${PORT}/api/evolve-prompt\n`);
});
// v1.1 — scheduling system
