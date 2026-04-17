/**
 * Souleora Voice Agent — Enhanced Memory Engine
 * 
 * Per-caller memory (by phone number)
 * Global learning memory (aggregated insights)
 * Emotion detection from call patterns
 * Caller name matching
 */

import fs from 'fs';
import path from 'path';

export class MemoryEngine {
  constructor(basePath) {
    this.basePath = basePath;
    this.callersDir = path.join(basePath, 'callers');
    this.globalMemoryFile = path.join(basePath, 'global-memory.json');
    this.emotionPatternsFile = path.join(basePath, 'emotion-patterns.json');
    this.slangDictionaryFile = path.join(basePath, 'slang-dictionary.json');
    
    // Ensure directories
    [this.callersDir].forEach(d => fs.mkdirSync(d, { recursive: true }));
    
    // Initialize global memory if needed
    if (!fs.existsSync(this.globalMemoryFile)) {
      fs.writeFileSync(this.globalMemoryFile, JSON.stringify({
        totalCalls: 0,
        totalMinutes: 0,
        topicsFrequency: {},
        satisfactionScores: [],
        averageSatisfaction: 0,
        bestPhrases: [],
        worstPhrases: [],
        commonQuestions: [],
        slangPatterns: [],
        emotionTriggers: [],
        signSpecificNotes: {},
        timeOfDayPatterns: {},
        lastUpdated: new Date().toISOString()
      }, null, 2));
    }

    if (!fs.existsSync(this.emotionPatternsFile)) {
      fs.writeFileSync(this.emotionPatternsFile, JSON.stringify({
        patterns: {
          excited: {
            indicators: ['wow', 'oh my god', 'that\'s so true', 'amazing', 'no way', 'shut up', 'are you serious'],
            response: 'Mirror their excitement, lean into the insight, go deeper on this topic'
          },
          skeptical: {
            indicators: ['really?', 'I don\'t know', 'hmm', 'I guess', 'maybe', 'sure', 'if you say so'],
            response: 'Get more specific, cite exact degrees and aspects, ask probing questions to build trust'
          },
          emotional: {
            indicators: ['crying', 'tears', 'that hit', 'I needed to hear that', 'thank you', '*sniffles*', 'voice breaking'],
            response: 'Slow down, soften tone, validate their feelings, give them space to process'
          },
          bored: {
            indicators: ['uh huh', 'ok', 'yeah', 'right', 'short responses', 'long silences'],
            response: 'Switch topics, ask what they specifically want to know, get interactive'
          },
          anxious: {
            indicators: ['worried', 'scared', 'nervous', 'what if', 'is it bad', 'should I be concerned'],
            response: 'Reassure, frame challenges as growth opportunities, emphasize free will and agency'
          },
          curious: {
            indicators: ['tell me more', 'what does that mean', 'why', 'how does that work', 'interesting'],
            response: 'Go deeper into the technical astrology, explain the mechanics, feed their curiosity'
          },
          romantic: {
            indicators: ['love', 'relationship', 'partner', 'soulmate', 'dating', 'marriage', 'he said', 'she said'],
            response: 'Focus on Venus, 7th house, synastry aspects, be warm and hopeful but honest'
          }
        }
      }, null, 2));
    }

    if (!fs.existsSync(this.slangDictionaryFile)) {
      fs.writeFileSync(this.slangDictionaryFile, JSON.stringify({
        learned: [],
        lastUpdated: new Date().toISOString()
      }, null, 2));
    }
  }

  // ===== PER-CALLER MEMORY =====
  
  getCallerFile(phoneNumber) {
    const sanitized = phoneNumber.replace(/[^0-9+]/g, '');
    return path.join(this.callersDir, `${sanitized}.json`);
  }

  getCallerProfile(phoneNumber) {
    const file = this.getCallerFile(phoneNumber);
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    return null;
  }

  createOrUpdateCaller(phoneNumber, data) {
    const file = this.getCallerFile(phoneNumber);
    let profile = this.getCallerProfile(phoneNumber) || {
      phoneNumber,
      name: null,
      names: [], // Track all names mentioned (in case they give different ones)
      firstCall: new Date().toISOString(),
      birthData: null,
      chartData: null,
      totalCalls: 0,
      totalMinutes: 0,
      calls: [],
      topics: [],
      emotionalProfile: {
        dominantEmotion: null,
        emotionHistory: []
      },
      preferences: {
        detailLevel: 'medium', // low, medium, high — based on engagement
        favoriteTopics: [],
        communicationStyle: 'unknown' // casual, formal, spiritual, skeptical
      },
      insights: [],
      lastCall: null
    };

    // Update with new data
    if (data.name && data.name !== 'unknown') {
      profile.name = data.name;
      if (!profile.names.includes(data.name)) {
        profile.names.push(data.name);
      }
    }

    if (data.birthData) {
      profile.birthData = data.birthData;
    }

    if (data.chartData) {
      profile.chartData = data.chartData;
    }

    profile.totalCalls++;
    profile.totalMinutes += (data.duration || 0) / 60;
    profile.lastCall = new Date().toISOString();

    if (data.callSummary) {
      profile.calls.push({
        date: new Date().toISOString(),
        duration: data.duration,
        summary: data.callSummary,
        topics: data.topics || [],
        emotions: data.emotions || [],
        satisfaction: data.satisfaction || null,
        keyMoments: data.keyMoments || []
      });
    }

    if (data.topics) {
      profile.topics = [...new Set([...profile.topics, ...data.topics])];
    }

    if (data.emotions && data.emotions.length > 0) {
      profile.emotionalProfile.emotionHistory.push({
        date: new Date().toISOString(),
        emotions: data.emotions
      });
      // Determine dominant emotion across all calls
      const allEmotions = profile.emotionalProfile.emotionHistory.flatMap(h => h.emotions);
      const freq = {};
      allEmotions.forEach(e => freq[e] = (freq[e] || 0) + 1);
      profile.emotionalProfile.dominantEmotion = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0];
    }

    if (data.insights) {
      profile.insights.push(...data.insights);
    }

    fs.writeFileSync(file, JSON.stringify(profile, null, 2));
    return profile;
  }

  // Generate context for Luna when a known caller calls back
  getCallerContext(phoneNumber) {
    const profile = this.getCallerProfile(phoneNumber);
    if (!profile) return null;

    let context = '';
    
    if (profile.name) {
      context += `RETURNING CALLER: ${profile.name} (call #${profile.totalCalls + 1})\n`;
    }

    if (profile.birthData) {
      context += `Birth data on file: ${JSON.stringify(profile.birthData)}\n`;
    }

    if (profile.chartData?.bigThree) {
      const bt = profile.chartData.bigThree;
      context += `Their Big Three: Sun ${bt.sun?.sign}, Moon ${bt.moon?.sign}, Rising ${bt.rising?.sign}\n`;
    }

    if (profile.calls.length > 0) {
      const lastCall = profile.calls[profile.calls.length - 1];
      context += `Last call: ${lastCall.date} — Topics: ${lastCall.topics.join(', ')}\n`;
      if (lastCall.summary) {
        context += `Last reading summary: ${lastCall.summary}\n`;
      }
    }

    if (profile.emotionalProfile.dominantEmotion) {
      context += `Emotional tendency: ${profile.emotionalProfile.dominantEmotion}\n`;
    }

    if (profile.preferences.favoriteTopics.length > 0) {
      context += `Usually asks about: ${profile.preferences.favoriteTopics.join(', ')}\n`;
    }

    context += `\nIMPORTANT: Greet them by name. Reference their previous reading naturally. They'll be impressed you remember.\n`;

    return context;
  }

  // ===== GLOBAL LEARNING MEMORY =====

  updateGlobalMemory(callAnalysis) {
    const global = JSON.parse(fs.readFileSync(this.globalMemoryFile, 'utf8'));

    global.totalCalls++;
    global.totalMinutes += (callAnalysis.duration || 0) / 60;

    // Topics frequency
    if (callAnalysis.topics) {
      callAnalysis.topics.forEach(t => {
        global.topicsFrequency[t] = (global.topicsFrequency[t] || 0) + 1;
      });
    }

    // Satisfaction tracking
    if (callAnalysis.satisfaction) {
      global.satisfactionScores.push(callAnalysis.satisfaction);
      global.averageSatisfaction = global.satisfactionScores.reduce((a, b) => a + b, 0) / global.satisfactionScores.length;
    }

    // Best phrases (Luna said something that got great reaction)
    if (callAnalysis.bestPhrases) {
      global.bestPhrases.push(...callAnalysis.bestPhrases);
      // Keep only the best 100
      global.bestPhrases = global.bestPhrases.slice(-100);
    }

    // Worst phrases (Luna said something that fell flat)
    if (callAnalysis.worstPhrases) {
      global.worstPhrases.push(...callAnalysis.worstPhrases);
      global.worstPhrases = global.worstPhrases.slice(-100);
    }

    // Common questions
    if (callAnalysis.questions) {
      global.commonQuestions.push(...callAnalysis.questions);
    }

    // Slang patterns
    if (callAnalysis.slang) {
      global.slangPatterns.push(...callAnalysis.slang);
      // Update slang dictionary
      this.updateSlangDictionary(callAnalysis.slang);
    }

    // Time of day patterns
    const hour = new Date().getHours();
    const timeSlot = hour < 6 ? 'late_night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
    if (!global.timeOfDayPatterns[timeSlot]) {
      global.timeOfDayPatterns[timeSlot] = { calls: 0, avgSatisfaction: 0, scores: [] };
    }
    global.timeOfDayPatterns[timeSlot].calls++;
    if (callAnalysis.satisfaction) {
      global.timeOfDayPatterns[timeSlot].scores.push(callAnalysis.satisfaction);
      global.timeOfDayPatterns[timeSlot].avgSatisfaction = 
        global.timeOfDayPatterns[timeSlot].scores.reduce((a, b) => a + b, 0) / 
        global.timeOfDayPatterns[timeSlot].scores.length;
    }

    // Sign-specific notes
    if (callAnalysis.callerSign && callAnalysis.engagementNotes) {
      if (!global.signSpecificNotes[callAnalysis.callerSign]) {
        global.signSpecificNotes[callAnalysis.callerSign] = [];
      }
      global.signSpecificNotes[callAnalysis.callerSign].push(callAnalysis.engagementNotes);
    }

    global.lastUpdated = new Date().toISOString();
    fs.writeFileSync(this.globalMemoryFile, JSON.stringify(global, null, 2));

    return global;
  }

  updateSlangDictionary(newSlang) {
    const dict = JSON.parse(fs.readFileSync(this.slangDictionaryFile, 'utf8'));
    newSlang.forEach(s => {
      const existing = dict.learned.find(l => l.phrase === s.phrase);
      if (existing) {
        existing.frequency++;
      } else {
        dict.learned.push({ phrase: s.phrase, meaning: s.meaning || '', frequency: 1, firstHeard: new Date().toISOString() });
      }
    });
    dict.lastUpdated = new Date().toISOString();
    fs.writeFileSync(this.slangDictionaryFile, JSON.stringify(dict, null, 2));
  }

  getGlobalContext() {
    const global = JSON.parse(fs.readFileSync(this.globalMemoryFile, 'utf8'));
    const slang = JSON.parse(fs.readFileSync(this.slangDictionaryFile, 'utf8'));

    let context = `LUNA'S LEARNING MEMORY (${global.totalCalls} calls analyzed):\n`;
    
    // Top topics people ask about
    const topTopics = Object.entries(global.topicsFrequency)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    if (topTopics.length > 0) {
      context += `Most requested topics: ${topTopics.map(([t, c]) => `${t} (${c}x)`).join(', ')}\n`;
    }

    // Learned slang
    const topSlang = slang.learned
      .filter(s => s.frequency >= 2)
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 15);
    if (topSlang.length > 0) {
      context += `Caller slang to mirror: ${topSlang.map(s => s.phrase).join(', ')}\n`;
    }

    // Best performing phrases
    if (global.bestPhrases.length > 0) {
      const recent = global.bestPhrases.slice(-5);
      context += `Phrases that get great reactions: ${recent.join(' | ')}\n`;
    }

    // Time of day adjustments
    const hour = new Date().getHours();
    const timeSlot = hour < 6 ? 'late_night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
    if (global.timeOfDayPatterns[timeSlot]) {
      const pattern = global.timeOfDayPatterns[timeSlot];
      context += `Time context: ${timeSlot} callers (avg satisfaction: ${pattern.avgSatisfaction.toFixed(1)}/10)\n`;
    }

    return context;
  }

  // ===== EMOTION DETECTION HELPERS =====

  detectEmotions(transcript) {
    const patterns = JSON.parse(fs.readFileSync(this.emotionPatternsFile, 'utf8')).patterns;
    const detected = [];
    const text = typeof transcript === 'string' ? transcript.toLowerCase() : JSON.stringify(transcript).toLowerCase();

    for (const [emotion, config] of Object.entries(patterns)) {
      const matchCount = config.indicators.filter(ind => text.includes(ind.toLowerCase())).length;
      if (matchCount >= 2) {
        detected.push({ emotion, confidence: matchCount / config.indicators.length, response: config.response });
      }
    }

    return detected.sort((a, b) => b.confidence - a.confidence);
  }

  // ===== STATS =====

  getStats() {
    const global = JSON.parse(fs.readFileSync(this.globalMemoryFile, 'utf8'));
    const callerFiles = fs.readdirSync(this.callersDir).filter(f => f.endsWith('.json'));
    const slang = JSON.parse(fs.readFileSync(this.slangDictionaryFile, 'utf8'));

    // Get returning callers
    let returningCallers = 0;
    callerFiles.forEach(f => {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(this.callersDir, f), 'utf8'));
        if (p.totalCalls > 1) returningCallers++;
      } catch {}
    });

    return {
      totalCalls: global.totalCalls,
      totalMinutes: Math.round(global.totalMinutes),
      uniqueCallers: callerFiles.length,
      returningCallers,
      returnRate: callerFiles.length > 0 ? Math.round((returningCallers / callerFiles.length) * 100) : 0,
      averageSatisfaction: global.averageSatisfaction ? global.averageSatisfaction.toFixed(1) : 'N/A',
      topTopics: Object.entries(global.topicsFrequency).sort((a, b) => b[1] - a[1]).slice(0, 5),
      learnedSlang: slang.learned.length,
      signBreakdown: Object.keys(global.signSpecificNotes).length,
      lastUpdated: global.lastUpdated
    };
  }
}
