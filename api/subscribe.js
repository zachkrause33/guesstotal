export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' });
  const API_KEY = process.env.MAILCHIMP_API_KEY;
  const AUDIENCE_ID = process.env.MAILCHIMP_AUDIENCE_ID;
  const DC = API_KEY.split('-')[1];
  try {
    const response = await fetch(`https://${DC}.api.mailchimp.com/3.0/lists/${AUDIENCE_ID}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `apikey ${API_KEY}` },
      body: JSON.stringify({ email_address: email, status: 'subscribed', tags: ['guesstotal'] }),
    });
    const data = await response.json();
    if (response.ok || data.title === 'Member Exists') return res.status(200).json({ success: true });
    return res.status(400).json({ error: data.detail || 'Failed' });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
}
