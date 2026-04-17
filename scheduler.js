/**
 * Souleora Scheduling + Payment + Outbound Calls
 * 
 * Flow: Customer books → pays via Stripe → gets SMS confirmation
 * → SMS reminder 15min before → Luna calls them at scheduled time
 * → Graceful ending with story + wrap-up
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOOKINGS_DIR = path.join(__dirname, '../bookings');
fs.mkdirSync(BOOKINGS_DIR, { recursive: true });

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const VAPI_KEY = process.env.VAPI_PRIVATE_KEY || 'a1ec8e32-6799-4365-8ce6-f79228258e02';
const LUNA_PHONE = '+15206755340';
const LUNA_ASSISTANT_ID = 'a95e5811-f93c-4f99-bb41-41c075977710';
const TWILIO_PHONE_SID = '0669995d-1ffc-4459-a338-277b82921146';

const PLANS = {
  '15min': { name: '15 Minute Reading', price: 2999, duration: 15, gracePeriod: 4 },
  '30min': { name: '30 Minute Reading', price: 4999, duration: 30, gracePeriod: 5 },
  '60min': { name: '60 Minute Reading', price: 7999, duration: 60, gracePeriod: 6 }
};

// Active scheduled calls (in-memory, persisted to disk)
let scheduledCalls = loadScheduledCalls();

function loadScheduledCalls() {
  const file = path.join(BOOKINGS_DIR, 'active-schedule.json');
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  }
  return [];
}

function saveScheduledCalls() {
  fs.writeFileSync(path.join(BOOKINGS_DIR, 'active-schedule.json'), JSON.stringify(scheduledCalls, null, 2));
}

export function mountSchedulerRoutes(app) {

  // ===== CREATE STRIPE CHECKOUT SESSION =====
  app.post('/api/book', async (req, res) => {
    try {
      const { name, phone, email, dob, tob, city, plan, focus, scheduledTime, timezone } = req.body;

      if (!name || !phone || !email || !dob || !city || !plan || !scheduledTime) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const planInfo = PLANS[plan];
      if (!planInfo) return res.status(400).json({ error: 'Invalid plan' });

      // Validate scheduled time
      const callTime = new Date(scheduledTime);
      const now = new Date();
      const minTime = new Date(now.getTime() + 5 * 60000); // 5 min from now
      const maxTime = new Date(now.getTime() + 15 * 24 * 60 * 60000); // 15 days

      if (callTime < minTime) return res.status(400).json({ error: 'Must be at least 5 minutes from now' });
      if (callTime > maxTime) return res.status(400).json({ error: 'Cannot book more than 15 days out' });

      // Check hours (6AM-11PM in customer's timezone)
      const callHour = callTime.getHours(); // This will be UTC, we trust the frontend sent correct UTC time
      // We'll validate on frontend with timezone awareness

      // Create Stripe checkout session
      const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${STRIPE_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          'mode': 'payment',
          'success_url': 'https://souleora.github.io/souleora-site/call.html?booked=true&session_id={CHECKOUT_SESSION_ID}',
          'cancel_url': 'https://souleora.github.io/souleora-site/call.html?cancelled=true',
          'customer_email': email,
          'line_items[0][price_data][currency]': 'usd',
          'line_items[0][price_data][product_data][name]': `Souleora ${planInfo.name} with Luna`,
          'line_items[0][price_data][product_data][description]': `Personalized astrology reading - ${planInfo.duration} minutes`,
          'line_items[0][price_data][unit_amount]': planInfo.price.toString(),
          'line_items[0][quantity]': '1',
          'metadata[name]': name,
          'metadata[phone]': phone,
          'metadata[dob]': dob,
          'metadata[tob]': tob || '12:00',
          'metadata[city]': city,
          'metadata[plan]': plan,
          'metadata[focus]': focus || 'general',
          'metadata[scheduledTime]': scheduledTime,
          'metadata[timezone]': timezone || 'America/Phoenix'
        })
      });

      const session = await stripeRes.json();

      if (session.url) {
        res.json({ checkoutUrl: session.url, sessionId: session.id });
      } else {
        console.error('[Stripe] Session error:', JSON.stringify(session).substring(0, 300));
        res.status(500).json({ error: 'Payment setup failed', detail: session.error?.message });
      }

    } catch (e) {
      console.error('[Book Error]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ===== STRIPE WEBHOOK (payment confirmed) =====
  app.post('/api/stripe-webhook', async (req, res) => {
    try {
      const event = req.body;

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const meta = session.metadata || {};

        console.log(`[Payment] Completed! ${meta.name} - ${meta.plan} - ${meta.scheduledTime}`);

        const booking = {
          id: `booking-${Date.now()}`,
          stripeSessionId: session.id,
          name: meta.name,
          phone: meta.phone,
          email: session.customer_email,
          dob: meta.dob,
          tob: meta.tob,
          city: meta.city,
          plan: meta.plan,
          focus: meta.focus,
          scheduledTime: meta.scheduledTime,
          timezone: meta.timezone,
          paidAt: new Date().toISOString(),
          amount: session.amount_total,
          status: 'scheduled',
          reminderSent: false,
          callInitiated: false
        };

        // Save booking
        fs.writeFileSync(path.join(BOOKINGS_DIR, `${booking.id}.json`), JSON.stringify(booking, null, 2));

        // Add to active schedule
        scheduledCalls.push(booking);
        saveScheduledCalls();

        // Send confirmation SMS
        await sendSMS(meta.phone, 
          `✨ Your Souleora reading is confirmed!\n\n` +
          `📞 Luna will call you at ${formatTime(meta.scheduledTime, meta.timezone)}\n` +
          `⏱ ${PLANS[meta.plan]?.name || meta.plan}\n` +
          `🔮 Focus: ${meta.focus || 'General Reading'}\n\n` +
          `We'll send a reminder 15 minutes before. See you among the stars! ✨\n\n` +
          `To reschedule, reply RESCHEDULE`
        );

        console.log(`[Booking] Confirmed: ${booking.id} for ${meta.name} at ${meta.scheduledTime}`);
      }

      res.json({ received: true });
    } catch (e) {
      console.error('[Webhook Error]', e);
      res.json({ received: true }); // Always 200
    }
  });

  // ===== GET AVAILABLE SLOTS =====
  app.get('/api/available-slots', (req, res) => {
    const { date, timezone } = req.query;
    if (!date) return res.status(400).json({ error: 'Date required (YYYY-MM-DD)' });

    const tz = timezone || 'America/Phoenix';
    const slots = generateAvailableSlots(date, tz);
    res.json({ date, timezone: tz, slots });
  });

  // ===== GET BOOKING STATUS =====
  app.get('/api/booking/:sessionId', async (req, res) => {
    try {
      // Look up by Stripe session ID
      const bookingFiles = fs.readdirSync(BOOKINGS_DIR).filter(f => f.startsWith('booking-'));
      for (const file of bookingFiles) {
        const booking = JSON.parse(fs.readFileSync(path.join(BOOKINGS_DIR, file), 'utf8'));
        if (booking.stripeSessionId === req.params.sessionId) {
          return res.json(booking);
        }
      }
      res.status(404).json({ error: 'Booking not found' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ===== RESCHEDULE =====
  app.post('/api/reschedule', async (req, res) => {
    try {
      const { bookingId, newTime } = req.body;
      const file = path.join(BOOKINGS_DIR, `${bookingId}.json`);
      if (!fs.existsSync(file)) return res.status(404).json({ error: 'Booking not found' });

      const booking = JSON.parse(fs.readFileSync(file, 'utf8'));
      const oldTime = booking.scheduledTime;
      booking.scheduledTime = newTime;
      booking.reminderSent = false;
      booking.callInitiated = false;
      booking.status = 'rescheduled';

      fs.writeFileSync(file, JSON.stringify(booking, null, 2));

      // Update active schedule
      const idx = scheduledCalls.findIndex(c => c.id === bookingId);
      if (idx >= 0) scheduledCalls[idx] = booking;
      saveScheduledCalls();

      await sendSMS(booking.phone,
        `🔄 Your reading has been rescheduled!\n\n` +
        `📞 Luna will now call you at ${formatTime(newTime, booking.timezone)}\n` +
        `See you then! ✨`
      );

      res.json({ success: true, booking });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ===== UPCOMING BOOKINGS (for dashboard) =====
  app.get('/api/dashboard/bookings', (req, res) => {
    const bookings = scheduledCalls
      .filter(b => b.status !== 'completed' && b.status !== 'cancelled')
      .sort((a, b) => new Date(a.scheduledTime) - new Date(b.scheduledTime));
    res.json(bookings);
  });

  // Start the call scheduler loop
  startCallScheduler();
}

// ===== CALL SCHEDULER — checks every 30 seconds =====
function startCallScheduler() {
  console.log('[Scheduler] Started — checking for upcoming calls every 30s');

  setInterval(async () => {
    const now = new Date();

    for (const booking of scheduledCalls) {
      if (booking.status === 'completed' || booking.status === 'cancelled' || booking.status === 'failed') continue;

      const callTime = new Date(booking.scheduledTime);
      const timeDiff = callTime - now;
      const minutesUntil = timeDiff / 60000;

      // Send reminder 15 minutes before
      if (!booking.reminderSent && minutesUntil <= 15 && minutesUntil > 10) {
        console.log(`[Scheduler] Sending reminder to ${booking.name} (${booking.phone})`);
        await sendSMS(booking.phone,
          `🔮 Hi ${booking.name}! Luna is getting ready for your reading in 15 minutes.\n\n` +
          `Find a quiet, comfortable space. She'll call you at ${LUNA_PHONE.replace('+1', '')} shortly.\n\n` +
          `✨ The stars are aligning for you...`
        );
        booking.reminderSent = true;
        saveScheduledCalls();
      }

      // Initiate the call at scheduled time (within 1 minute window)
      if (!booking.callInitiated && minutesUntil <= 0.5 && minutesUntil > -2) {
        console.log(`[Scheduler] 📞 CALLING ${booking.name} at ${booking.phone}!`);
        await initiateOutboundCall(booking);
        booking.callInitiated = true;
        booking.status = 'in-progress';
        saveScheduledCalls();
      }

      // Mark as missed if 5+ minutes past and never called
      if (!booking.callInitiated && minutesUntil < -5) {
        booking.status = 'missed';
        saveScheduledCalls();
        console.log(`[Scheduler] Missed call for ${booking.name}`);
      }
    }
  }, 30000);
}

// ===== INITIATE OUTBOUND CALL VIA VAPI =====
async function initiateOutboundCall(booking) {
  try {
    const planInfo = PLANS[booking.plan] || PLANS['30min'];
    const totalSeconds = (planInfo.duration + planInfo.gracePeriod) * 60;

    // Build custom context for this call
    const callerContext = `
SCHEDULED CALL CONTEXT:
- Caller name: ${booking.name}
- Birth date: ${booking.dob}
- Birth time: ${booking.tob || 'unknown'}
- Birth city: ${booking.city}
- Reading focus: ${booking.focus || 'general'}
- Plan: ${planInfo.name} (${planInfo.duration} minutes + ${planInfo.gracePeriod} min grace)
- They PAID for this reading — make it worth every penny.

IMPORTANT TIMING:
- You have ${planInfo.duration} minutes for the main reading.
- At the ${planInfo.duration - 2} minute mark, begin wrapping up naturally.
- Say something like: "I want to be mindful of your time — I have another soul waiting for their reading, but before I go, let me share one last thing I see in your chart..."
- This gives you ${planInfo.gracePeriod} minutes to close beautifully.
- Do NOT abruptly end. Make the ending feel special and complete.
- At the very end: "Thank you so much for sharing this time with me, ${booking.name}. Remember — the stars illuminate the path, but you walk it. Take care of yourself. Goodbye."

OPENING: "Hi ${booking.name}! This is Luna from Souleora. I've been looking forward to your reading — I already pulled up your chart and I have to say, there's some really beautiful energy here. Are you in a comfortable spot? Great, let's dive in..."
`;

    const response = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VAPI_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        assistantId: LUNA_ASSISTANT_ID,
        assistantOverrides: {
          firstMessage: `Hi ${booking.name}! This is Luna from Souleora. I've been so looking forward to your reading. I already pulled up your chart and I have to tell you, there's some really fascinating energy here. Are you somewhere comfortable where we can chat?`,
          model: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-20250514',
            messages: [{
              role: 'system',
              content: callerContext + '\n\n' + fs.readFileSync(path.join(__dirname, '../system-prompt.md'), 'utf8')
            }],
            temperature: 0.85,
            maxTokens: 500
          },
          maxDurationSeconds: totalSeconds
        },
        phoneNumberId: TWILIO_PHONE_SID,
        customer: {
          number: booking.phone,
          name: booking.name
        }
      })
    });

    const result = await response.json();

    if (result.id) {
      console.log(`[Call] ✅ Outbound call initiated: ${result.id} to ${booking.phone}`);
      booking.vapiCallId = result.id;

      // Save the booking update
      const file = path.join(BOOKINGS_DIR, `${booking.id}.json`);
      fs.writeFileSync(file, JSON.stringify(booking, null, 2));
    } else {
      console.error(`[Call] ❌ Failed:`, JSON.stringify(result).substring(0, 300));
      booking.status = 'failed';
      booking.error = result.message || 'Unknown error';
    }

  } catch (e) {
    console.error(`[Call] Error initiating call:`, e.message);
    booking.status = 'failed';
    booking.error = e.message;
  }
}

// ===== SEND SMS VIA TWILIO =====
async function sendSMS(to, body) {
  try {
    const params = new URLSearchParams({
      To: to,
      From: LUNA_PHONE,
      Body: body
    });

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params
      }
    );

    const result = await response.json();
    if (result.sid) {
      console.log(`[SMS] ✅ Sent to ${to}: ${body.substring(0, 50)}...`);
    } else {
      console.error(`[SMS] ❌ Failed:`, result.message);
    }
    return result;
  } catch (e) {
    console.error(`[SMS] Error:`, e.message);
  }
}

// ===== GENERATE AVAILABLE SLOTS =====
function generateAvailableSlots(dateStr, timezone) {
  const slots = [];
  const date = new Date(dateStr + 'T00:00:00');

  // Generate slots from 6AM to 11PM, every 30 minutes
  for (let hour = 6; hour <= 22; hour++) {
    for (let min of [0, 30]) {
      if (hour === 22 && min === 30) continue; // Don't start at 10:30 PM

      const slotTime = new Date(date);
      slotTime.setHours(hour, min, 0, 0);

      // Check if slot is already booked
      const isBooked = scheduledCalls.some(b => {
        if (b.status === 'cancelled' || b.status === 'completed') return false;
        const bookedTime = new Date(b.scheduledTime);
        const diff = Math.abs(bookedTime - slotTime) / 60000;
        const duration = PLANS[b.plan]?.duration || 30;
        return diff < duration + 15; // Buffer of 15 min between calls
      });

      // Check if slot is in the past
      const now = new Date();
      const isPast = slotTime < new Date(now.getTime() + 5 * 60000);

      slots.push({
        time: slotTime.toISOString(),
        display: `${hour > 12 ? hour - 12 : hour}:${min === 0 ? '00' : '30'} ${hour >= 12 ? 'PM' : 'AM'}`,
        available: !isBooked && !isPast,
        booked: isBooked
      });
    }
  }

  return slots;
}

function formatTime(isoString, timezone) {
  try {
    const date = new Date(isoString);
    return date.toLocaleString('en-US', {
      timeZone: timezone || 'America/Phoenix',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  } catch {
    return isoString;
  }
}
