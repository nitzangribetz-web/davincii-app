const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');

// POST /api/approvals — Create an approval request (fallback when edge functions unavailable)
router.post('/', async (req, res) => {
  try {
    const { description, context = {}, prompt_hash, source = 'claude-code' } = req.body;

    if (!description || !prompt_hash) {
      return res.status(400).json({ error: 'description and prompt_hash are required' });
    }

    const { data, error } = await supabase
      .from('approval_requests')
      .insert({
        prompt_hash,
        description,
        context,
        source,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw error;

    // Optionally send Slack notification if tokens are configured
    if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL_ID) {
      try {
        await sendSlackNotification(data);
      } catch (slackErr) {
        console.error('Slack notification failed:', slackErr.message);
      }
    }

    res.json({ id: data.id, status: data.status });
  } catch (err) {
    console.error('Create approval error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/approvals/:id — Poll approval status
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('approval_requests')
      .select('id, status, description, responded_at, created_at')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Not found' });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/approvals/:id/respond — Manual approve/deny
router.post('/:id/respond', async (req, res) => {
  try {
    const { status } = req.body;

    if (!['approved', 'denied'].includes(status)) {
      return res.status(400).json({ error: 'status must be "approved" or "denied"' });
    }

    const { data, error } = await supabase
      .from('approval_requests')
      .update({
        status,
        responded_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .eq('status', 'pending')
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Not found or already responded' });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/approvals — List recent approval requests
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const { data, error } = await supabase
      .from('approval_requests')
      .select('id, status, description, source, created_at, responded_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function sendSlackNotification(row) {
  const contextLines = Object.entries(row.context || {})
    .map(([k, v]) => `*${k}:* ${v}`)
    .join('\n');

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '\u26a0\ufe0f Approval Required', emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${row.description}*` },
    },
    ...(contextLines
      ? [{ type: 'section', text: { type: 'mrkdwn', text: contextLines } }]
      : []),
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Source: \`${row.source}\` | ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`,
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve', emoji: true },
          style: 'primary',
          action_id: 'approve',
          value: row.id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Deny', emoji: true },
          style: 'danger',
          action_id: 'deny',
          value: row.id,
        },
      ],
    },
  ];

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: process.env.SLACK_CHANNEL_ID,
      text: `Approval required: ${row.description}`,
      blocks,
    }),
  });

  const data = await res.json();

  if (data.ok) {
    await supabase
      .from('approval_requests')
      .update({ slack_ts: data.ts, slack_channel: data.channel })
      .eq('id', row.id);
  }

  return data;
}

module.exports = router;
