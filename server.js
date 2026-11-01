require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3050;

// Allow embedding in Shopify Admin iframe & remove X-Frame-Options blocking
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors https://*.myshopify.com https://admin.shopify.com https://*.spin.dev 'self';"
  );
  res.removeHeader('X-Frame-Options');
  next();
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
// Serve index.html with dynamic SHOPIFY_CLIENT_ID injection for App Bridge
app.get(['/', '/index.html'], (req, res) => {
  try {
    const clientId = process.env.SHOPIFY_CLIENT_ID || '4ae310939fe47a621519ca91b1ed3bc1';
    let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf-8');
    html = html.replace(/content="4ae310939fe47a621519ca91b1ed3bc1"/g, `content="${clientId}"`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// Shopify OAuth Callback route
app.get(['/auth/callback', '/api/auth/callback'], (req, res) => {
  const shop = req.query.shop || 'shop.thedentalshaman.com';
  const host = req.query.host || '';
  res.redirect(`/?shop=${shop}&host=${host}`);
});

// Master Security Gate & Session Management
const MASTER_ACCESS_CODE = process.env.MASTER_ACCESS_CODE || 'TDS-CRD#3D0AD04A-70970879-A829CBF5';

// Brute-force protection: IP -> { attempts, lockedUntil }
const loginAttempts = new Map();

function isIpLocked(ip) {
  const record = loginAttempts.get(ip);
  if (!record) return false;
  if (Date.now() < record.lockedUntil) return true;
  if (Date.now() >= record.lockedUntil && record.lockedUntil > 0) {
    loginAttempts.delete(ip);
    return false;
  }
  return false;
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip) || { attempts: 0, lockedUntil: 0 };
  record.attempts += 1;
  if (record.attempts >= 5) {
    record.lockedUntil = now + (15 * 60 * 1000);
    console.warn(`[Security Alert] IP ${ip} temporarily locked out for 15 minutes due to 5 failed attempts.`);
  }
  loginAttempts.set(ip, record);
}

function clearFailedAttempts(ip) {
  loginAttempts.delete(ip);
}

function safeCompareKeys(inputKey, targetKey) {
  if (!inputKey || !targetKey) return false;
  try {
    const hashA = crypto.createHash('sha256').update(String(inputKey).trim()).digest();
    const hashB = crypto.createHash('sha256').update(String(targetKey).trim()).digest();
    if (crypto.timingSafeEqual(hashA, hashB)) return true;
  } catch (e) {}
  const cleanInput = String(inputKey).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const cleanTarget = String(targetKey).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleanInput === cleanTarget;
}

const sessions = new Map();

function validateToken(token) {
  if (!token) return false;
  const sess = sessions.get(token);
  if (!sess) return false;
  if (Date.now() > sess.expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// Authentication API Endpoints
app.post('/api/auth/access', (req, res) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (isIpLocked(clientIp)) {
    const record = loginAttempts.get(clientIp);
    const remainingMins = Math.ceil((record.lockedUntil - Date.now()) / 60000);
    return res.status(429).json({
      success: false,
      error: `Security lockout: Too many failed attempts. Try again in ${remainingMins} minute(s).`
    });
  }

  const { accessKey } = req.body || {};
  if (!accessKey) {
    return res.status(401).json({ success: false, error: 'Master access key is required.' });
  }

  if (!safeCompareKeys(accessKey, MASTER_ACCESS_CODE)) {
    recordFailedAttempt(clientIp);
    console.warn(`[Security] Unauthorized access attempt from ${clientIp}`);
    const remaining = Math.max(0, 5 - ((loginAttempts.get(clientIp) || {}).attempts || 0));
    return res.status(401).json({
      success: false,
      error: remaining > 0
        ? `Invalid master operator key. (${remaining} attempts remaining before temporary lockout)`
        : 'Invalid master operator key. Security lockout activated for 15 minutes.'
    });
  }

  clearFailedAttempts(clientIp);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    createdAt: Date.now(),
    expiresAt: Date.now() + (30 * 24 * 60 * 60 * 1000) // 30 days valid
  });
  console.log(`[Security] Master access granted successfully to ${clientIp}`);
  res.json({ success: true, token });
});

app.get('/api/auth/verify', (req, res) => {
  const authHeader = req.headers['authorization'];
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }
  if (validateToken(token)) {
    return res.json({ success: true });
  }
  return res.status(401).json({ success: false, error: 'Invalid or expired session.' });
});

app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers['authorization'];
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }
  if (token) sessions.delete(token);
  res.json({ success: true });
});

// Protect all /api endpoints except /api/auth and public health checks
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) {
    return next();
  }
  const authHeader = req.headers['authorization'];
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }
  if (!validateToken(token)) {
    return res.status(401).json({ error: 'Unauthorized: Master Access Key required.' });
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Lightweight Health Check endpoint for Render and cron-job.org
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// Configuration
const SHOPIFY_DOMAIN = process.env.SHOPIFY_MYSHOPIFY_DOMAIN || 'myjrue-ku.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const API_VERSION = process.env.API_VERSION || '2024-01';
const STORE_URL = 'https://shop.thedentalshaman.com';

const DATA_FILE = path.join(__dirname, 'data', 'credit_records.json');
const TEMPLATE_FILE = path.join(__dirname, 'templates', 'shopify-credit-template.html');
const TEMPLATE_DEFAULT_FILE = path.join(__dirname, 'templates', 'shopify-credit-template.default.html');
const TEMPLATE_BACKUP_FILE = path.join(__dirname, 'templates', 'shopify-credit-template.backup.html');
const CONFIG_FILE = path.join(__dirname, 'templates', 'template-config.json');

function getSubject() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (data && data.subject) return data.subject;
    }
  } catch (e) {}
  return "You've received £10 store credit from The Dental Shaman";
}

function saveSubject(subject) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ subject }, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save template config:', e.message);
  }
}

function formatCustomerName(firstName, email) {
  if (firstName && firstName.trim() && firstName.trim().toLowerCase() !== 'valued customer') {
    const raw = firstName.trim();
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }
  if (email && typeof email === 'string') {
    const username = email.split('@')[0];
    const match = username.match(/^[a-zA-Z]+/);
    if (match && match[0].length >= 2) {
      const extracted = match[0];
      return extracted.charAt(0).toUpperCase() + extracted.slice(1).toLowerCase();
    }
  }
  return 'there';
}

function renderSubject(firstName, customSubject, email) {
  const base = customSubject || getSubject();
  const name = formatCustomerName(firstName, email);
  return base
    .replace(/\{\{first_name\}\}/gi, name)
    .replace(/\{\{FIRST_NAME\}\}/g, name)
    .replace(/\{\{store_credit\}\}/gi, '£10.00')
    .replace(/\{\{shop_name\}\}/gi, 'The Dental Shaman');
}

// Universal Email Dispatcher: Resend REST API (HTTPS Port 443 - Sub-second speed) with SMTP Fallback
async function sendEmailUniversal(mailOptions) {
  const resendApiKey = process.env.RESEND_API_KEY;
  if (resendApiKey && resendApiKey.trim()) {
    try {
      const fromName = process.env.DEFAULT_FROM_NAME || 'Dr. Marc Mortiboys | The Dental Shaman';
      const fromEmail = process.env.DEFAULT_FROM_EMAIL || 'shop@thedentalshaman.com';
      const replyTo = mailOptions.replyTo || process.env.DEFAULT_REPLY_TO || fromEmail;

      const payload = {
        from: `${fromName} <${fromEmail}>`,
        to: Array.isArray(mailOptions.to) ? mailOptions.to : [mailOptions.to],
        reply_to: replyTo,
        subject: mailOptions.subject,
        html: mailOptions.html
      };

      const res = await axios.post('https://api.resend.com/emails', payload, {
        headers: {
          'Authorization': `Bearer ${resendApiKey.trim()}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      return {
        info: { messageId: res.data?.id || `resend_${Date.now()}` },
        usedPort: 443,
        usedConfig: 'Resend REST API (HTTPS Port 443)'
      };
    } catch (err) {
      const errMsg = err.response?.data?.message || err.message;
      console.warn(`[Universal Dispatcher] Resend API dispatch error: ${errMsg}. Attempting SMTP fallback...`);
    }
  }

  // Fallback to SMTP
  return await sendEmailWithFallback(mailOptions);
}

// Hostinger SMTP Transporter with Resilient Multi-Port Fallback (Port 587 TLS / Port 465 SSL)
async function sendEmailWithFallback(mailOptions) {
  const host = process.env.SMTP_HOST || 'smtp.hostinger.com';
  const user = process.env.SMTP_USER || 'shop@thedentalshaman.com';
  const pass = process.env.SMTP_PASS;

  // Cloud containers on Render connect reliably via Port 587 (TLS/STARTTLS) or Port 465 (SSL)
  const attempts = [
    { port: 587, secure: false, name: 'Port 587 (TLS)' },
    { port: 465, secure: true, name: 'Port 465 (SSL)' }
  ];

  // If explicitly configured to 465, try 465 first
  const configuredPort = parseInt(process.env.SMTP_PORT || '465', 10);
  if (configuredPort === 465) {
    attempts.reverse();
  }

  let lastError = null;
  for (const config of attempts) {
    try {
      const transport = nodemailer.createTransport({
        host,
        port: config.port,
        secure: config.secure,
        auth: { user, pass },
        tls: {
          rejectUnauthorized: false
        },
        connectionTimeout: 6000,
        greetingTimeout: 6000,
        socketTimeout: 8000
      });

      const info = await transport.sendMail(mailOptions);
      return { info, usedPort: config.port, usedConfig: config.name };
    } catch (err) {
      lastError = err;
      console.warn(`[SMTP] Attempt via ${config.name} failed: ${err.message}. Trying next fallback...`);
    }
  }

  const isTimeout = lastError && (lastError.code === 'ETIMEDOUT' || lastError.message.includes('timeout') || lastError.message.includes('Connection timeout'));
  if (isTimeout) {
    throw new Error('Render Free Tier blocks raw SMTP ports 465 & 587. Please add RESEND_API_KEY in Render environment variables for instant sub-second delivery, or upgrade Render service to Starter ($7/mo) to unblock raw SMTP ports.');
  }

  throw lastError || new Error('All SMTP connection attempts failed.');
}

// App State
let state = {
  priceRuleId: process.env.PRICE_RULE_ID || '1878761963849',
  isSending: false,
  isPaused: false,
  customers: [],
  logs: []
};

// SSE Clients for Real-Time Streaming
let sseClients = [];

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(payload));
}

function addLog(msg, level = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const entry = { id: Date.now() + Math.random(), timestamp, msg, level };
  state.logs.push(entry);
  if (state.logs.length > 500) state.logs.shift();
  broadcast('log', entry);
  console.log(`[${timestamp}] [${level.toUpperCase()}] ${msg}`);
}

function saveRecords() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state.customers, null, 2));
  } catch (err) {
    console.error('Error saving data records:', err.message);
  }
}

function loadRecords() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      state.customers = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      console.log(`Loaded ${state.customers.length} customer records from disk.`);
    } catch (e) {
      console.error('Failed to parse records file, starting fresh.');
      state.customers = [];
    }
  }
}

loadRecords();

// Shopify API Helper
const shopifyApi = axios.create({
  baseURL: `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}`,
  headers: {
    'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    'Content-Type': 'application/json'
  }
});

// Ensure Price Rule Exists
async function getOrCreatePriceRule() {
  try {
    if (state.priceRuleId) {
      try {
        const check = await shopifyApi.get(`/price_rules/${state.priceRuleId}.json`);
        if (check.data && check.data.price_rule) {
          return state.priceRuleId;
        }
      } catch (e) {
        // Continue to find or create
      }
    }

    const res = await shopifyApi.get('/price_rules.json?limit=50');
    const existing = (res.data.price_rules || []).find(r => r.title === 'TDS-STORE-CREDIT-10GBP');
    if (existing) {
      state.priceRuleId = existing.id;
      return existing.id;
    }

    const created = await shopifyApi.post('/price_rules.json', {
      price_rule: {
        title: 'TDS-STORE-CREDIT-10GBP',
        target_type: 'line_item',
        target_selection: 'all',
        allocation_method: 'across',
        value_type: 'fixed_amount',
        value: '-10.00',
        customer_selection: 'all',
        starts_at: new Date().toISOString(),
        usage_limit: 1
      }
    });

    state.priceRuleId = created.data.price_rule.id;
    addLog(`Created master £10 Price Rule in Shopify (ID: ${state.priceRuleId})`, 'success');
    return state.priceRuleId;
  } catch (err) {
    addLog(`Failed to ensure price rule: ${err.response?.data?.errors || err.message}`, 'error');
    throw err;
  }
}

// Fetch all customers from Shopify via Cursor Pagination
async function fetchAllShopifyCustomers() {
  addLog('Fetching all customers from shop.thedentalshaman.com API...', 'info');
  let all = [];
  let url = '/customers.json?limit=250&fields=id,email,first_name,last_name,phone,orders_count';
  
  while (url) {
    const res = await shopifyApi.get(url);
    const list = res.data.customers || [];
    all = all.concat(list);
    addLog(`Retrieved ${all.length} customers so far...`, 'info');

    // Parse Link header for next page
    const linkHeader = res.headers['link'];
    url = null;
    if (linkHeader) {
      const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (match) {
        url = match[1].replace(`https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}`, '');
      }
    }
  }

  // Merge with existing local records to preserve sent statuses
  const existingMap = new Map(state.customers.map(c => [String(c.id), c]));
  
  const merged = all.map(c => {
    const hasEmail = c.email && c.email.trim().length > 0;
    const cleanEmail = hasEmail ? c.email.trim().toLowerCase() : null;
    const prev = existingMap.get(String(c.id));
    
    if (prev) {
      return {
        ...prev,
        first_name: c.first_name || prev.first_name || '',
        last_name: c.last_name || prev.last_name || '',
        phone: c.phone || prev.phone || null,
        email: cleanEmail,
        status: cleanEmail ? prev.status : 'no_email'
      };
    }

    return {
      id: String(c.id),
      first_name: c.first_name || '',
      last_name: c.last_name || '',
      phone: c.phone || null,
      email: cleanEmail,
      code: null,
      status: cleanEmail ? 'pending' : 'no_email',
      sentAt: null,
      error: cleanEmail ? null : 'Phone-only customer (No email in Shopify)'
    };
  });

  state.customers = merged;
  saveRecords();
  const withEmailCount = state.customers.filter(c => c.email).length;
  const phoneOnlyCount = state.customers.filter(c => !c.email).length;
  addLog(`Total Shopify customers synchronized: ${state.customers.length} (${withEmailCount} with email, ${phoneOnlyCount} phone-only)`, 'success');
  broadcast('state_update', getStats());
  return state.customers;
}

// Generate Unique Code
function generateCode(name, id) {
  let cleanName = (name || '').replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 8);
  if (!cleanName) cleanName = 'VIP';
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `TDS10-${cleanName}-${rand}`;
}

// Shopify GraphQL API Client (2024-10 for native Store Credit)
const shopifyGql = axios.create({
  baseURL: `https://${SHOPIFY_DOMAIN}/admin/api/2024-10/graphql.json`,
  headers: {
    'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    'Content-Type': 'application/json'
  }
});

// Issue Official Native Store Credit to Customer Account in Shopify
async function creditCustomerAccount(customerId, amount = 10.0) {
  const mutation = `
    mutation storeCreditAccountCredit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
      storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
        storeCreditAccountTransaction {
          amount {
            amount
            currencyCode
          }
          account {
            id
            balance {
              amount
              currencyCode
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    id: `gid://shopify/Customer/${customerId}`,
    creditInput: {
      creditAmount: {
        amount: parseFloat(amount),
        currencyCode: 'GBP'
      }
    }
  };

  const res = await shopifyGql.post('', { query: mutation, variables });
  const data = res.data?.data?.storeCreditAccountCredit;
  if (data?.userErrors && data.userErrors.length > 0) {
    throw new Error(data.userErrors.map(e => e.message).join(', '));
  }
  return data?.storeCreditAccountTransaction?.account;
}

// Render Email HTML
function renderEmail(firstName, email) {
  let template = fs.readFileSync(TEMPLATE_FILE, 'utf8');
  const name = formatCustomerName(firstName, email);
  
  return template
    .replace(/\{\{FIRST_NAME\}\}/g, name)
    .replace(/\{\{first_name\}\}/gi, name);
}

// Calculate Stats
function getStats() {
  const total = state.customers.length;
  const sent = state.customers.filter(c => c.status === 'sent').length;
  const failed = state.customers.filter(c => c.status === 'failed').length;
  const noEmail = state.customers.filter(c => c.status === 'no_email').length;
  const withEmailTotal = total - noEmail;
  const pending = state.customers.filter(c => c.status === 'pending').length;
  const progressPercent = withEmailTotal > 0 ? Math.round((sent / withEmailTotal) * 100) : 0;
  
  return {
    total,
    withEmailTotal,
    noEmail,
    sent,
    failed,
    pending,
    progressPercent,
    isSending: state.isSending,
    isPaused: state.isPaused
  };
}

// Batch Sender Loop
async function runBatch() {
  if (state.isSending) return;
  state.isSending = true;
  state.isPaused = false;
  addLog('Starting 1-Click Official Store Credit (£10) distribution...', 'info');

  for (let i = 0; i < state.customers.length; i++) {
    // If paused, wait until resumed
    while (state.isPaused && state.isSending) {
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!state.isSending) {
      addLog('Batch sending stopped by user.', 'warn');
      break;
    }

    const c = state.customers[i];
    if (c.status === 'sent' || c.status === 'no_email') continue; // Skip sent and phone-only

    try {
      // 1. Issue Official Shopify Native Store Credit (£10.00 GBP) if not already credited
      if (!c.creditAccountId) {
        const account = await creditCustomerAccount(c.id, 10.0);
        c.creditAccountId = account?.id || null;
        c.creditBalance = '£10.00 GBP';
      }

      // 2. Send Official Notification Email via Universal Dispatcher (Resend REST API or Hostinger SMTP)
      const html = renderEmail(c.first_name, c.email);
      const subject = renderSubject(c.first_name, null, c.email);
      const { info, usedConfig } = await sendEmailUniversal({
        from: `"${process.env.DEFAULT_FROM_NAME || 'The Dental Shaman'}" <${process.env.DEFAULT_FROM_EMAIL || 'shop@thedentalshaman.com'}>`,
        replyTo: process.env.DEFAULT_REPLY_TO || 'shop@thedentalshaman.com',
        to: c.email,
        subject: subject,
        html: html
      });

      c.status = 'sent';
      c.sentAt = new Date().toISOString();
      c.error = null;
      addLog(`[CREDITED & SENT] ${c.email} | Shopify Store Credit: £10.00 GBP via ${usedConfig}`, 'success');
    } catch (err) {
      c.status = 'failed';
      c.error = err.message;
      addLog(`[FAILED] ${c.email}: ${c.error}`, 'error');
    }

    // Save and broadcast progress every record
    saveRecords();
    broadcast('customer_update', c);
    broadcast('progress', getStats());

    // Polite delay for high-throughput distribution (300ms)
    await new Promise(r => setTimeout(r, 300));
  }

  state.isSending = false;
  state.isPaused = false;
  addLog('Official Store Credit distribution cycle finished!', 'success');
  broadcast('batch_complete', getStats());
}

// REST ENDPOINTS

// Stream SSE logs and live updates
app.get('/api/stream-logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send initial history
  res.write(`event: initial_logs\ndata: ${JSON.stringify(state.logs)}\n\n`);
  res.write(`event: progress\ndata: ${JSON.stringify(getStats())}\n\n`);

  sseClients.push(res);
  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

app.get('/api/status', (req, res) => {
  res.json(getStats());
});

app.get('/api/customers', (req, res) => {
  res.json({
    stats: getStats(),
    customers: state.customers
  });
});

app.post('/api/refresh-customers', async (req, res) => {
  try {
    const list = await fetchAllShopifyCustomers();
    res.json({ success: true, count: list.length, stats: getStats() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Template Preview
app.get('/api/preview-template', (req, res) => {
  const html = renderEmail(req.query.name || 'Valued Customer');
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// Get Current Email Template
app.get('/api/template', (req, res) => {
  try {
    if (!fs.existsSync(TEMPLATE_FILE)) {
      if (fs.existsSync(TEMPLATE_DEFAULT_FILE)) {
        fs.copyFileSync(TEMPLATE_DEFAULT_FILE, TEMPLATE_FILE);
      } else {
        return res.status(404).json({ error: 'Template file not found' });
      }
    }
    const html = fs.readFileSync(TEMPLATE_FILE, 'utf8');
    const stats = fs.statSync(TEMPLATE_FILE);
    res.json({
      success: true,
      html,
      subject: getSubject(),
      lastModified: stats.mtime
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save Email Template
app.post('/api/template', (req, res) => {
  const { html, subject } = req.body;
  if (typeof html !== 'string') {
    return res.status(400).json({ error: 'Invalid template content' });
  }

  try {
    // Save backup before overwriting
    if (fs.existsSync(TEMPLATE_FILE)) {
      fs.copyFileSync(TEMPLATE_FILE, TEMPLATE_BACKUP_FILE);
    }
    fs.writeFileSync(TEMPLATE_FILE, html, 'utf8');
    if (subject && typeof subject === 'string') {
      saveSubject(subject);
    }
    addLog(`[TEMPLATE SAVED] Email template and subject line updated. Next dispatches will use this template.`, 'success');
    res.json({ success: true, message: 'Template saved successfully', length: html.length, subject: getSubject() });
  } catch (err) {
    addLog(`[TEMPLATE ERROR] Failed to save template: ${err.message}`, 'error');
    res.status(500).json({ error: err.message });
  }
});

// Reset Email Template to Default
app.post('/api/template/reset', (req, res) => {
  try {
    if (fs.existsSync(TEMPLATE_DEFAULT_FILE)) {
      const defaultHtml = fs.readFileSync(TEMPLATE_DEFAULT_FILE, 'utf8');
      fs.writeFileSync(TEMPLATE_FILE, defaultHtml, 'utf8');
      const defaultSubject = "You've received £10 store credit from The Dental Shaman";
      saveSubject(defaultSubject);
      addLog(`[TEMPLATE RESET] Restored default £10 Store Credit template & subject.`, 'info');
      res.json({ success: true, html: defaultHtml, subject: defaultSubject, message: 'Template reset to default.' });
    } else {
      res.status(404).json({ error: 'Default template not found.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test Send (Credits the customer in Shopify + sends the preview email)
app.post('/api/test-email', async (req, res) => {
  const { email, firstName, subject: customSubject } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const cleanEmail = email.trim().toLowerCase();

  try {
    addLog(`Searching or creating customer in Shopify for test credit: ${cleanEmail}...`, 'info');

    let customerId = null;
    // 1. Search Shopify for customer
    const searchRes = await shopifyApi.get(`/customers/search.json?query=email:${encodeURIComponent(cleanEmail)}`);
    if (searchRes.data?.customers && searchRes.data.customers.length > 0) {
      customerId = String(searchRes.data.customers[0].id);
      addLog(`Found existing Shopify customer profile for ${cleanEmail} (ID: ${customerId})`, 'info');
    } else {
      // Create customer in Shopify if not already registered
      const created = await shopifyApi.post('/customers.json', {
        customer: {
          email: cleanEmail,
          first_name: firstName || 'Valued',
          last_name: 'Customer',
          verified_email: true
        }
      });
      customerId = String(created.data.customer.id);
      addLog(`Created new Shopify customer profile for ${cleanEmail} (ID: ${customerId})`, 'info');
    }

    // 2. Issue Official Shopify Native Store Credit (£10.00 GBP)
    addLog(`Issuing £10.00 GBP native store credit to customer ID ${customerId}...`, 'info');
    const creditAcc = await creditCustomerAccount(customerId, 10.0);
    const balance = creditAcc?.balance?.amount || '10.0';
    addLog(`[CREDITED] Shopify Store Credit of £${balance} GBP active on ${cleanEmail}!`, 'success');

    // Update local database record if found
    const local = state.customers.find(c => c.email && c.email.toLowerCase() === cleanEmail);
    if (local) {
      local.status = 'sent';
      local.creditAccountId = creditAcc?.id || null;
      local.creditBalance = `£${balance} GBP`;
      local.sentAt = new Date().toISOString();
      saveRecords();
      broadcast('customer_update', local);
      broadcast('progress', getStats());
    }

    // 3. Send the Test Email via Universal Dispatcher (Resend REST API or Hostinger SMTP)
    const resolvedName = (firstName && firstName.trim() && firstName.trim().toLowerCase() !== 'valued customer')
      ? firstName.trim()
      : (local ? local.first_name : null);
    const html = renderEmail(resolvedName, cleanEmail);
    const subject = renderSubject(resolvedName, customSubject, cleanEmail);
    const { info, usedConfig } = await sendEmailUniversal({
      from: `"${process.env.DEFAULT_FROM_NAME || 'The Dental Shaman'}" <${process.env.DEFAULT_FROM_EMAIL || 'shop@thedentalshaman.com'}>`,
      replyTo: process.env.DEFAULT_REPLY_TO || 'shop@thedentalshaman.com',
      to: cleanEmail,
      subject: `[TEST PREVIEW] ${subject}`,
      html: html
    });

    addLog(`Test email dispatched successfully to ${cleanEmail} via ${usedConfig} (MessageID: ${info.messageId})`, 'success');
    res.json({
      success: true,
      messageId: info.messageId,
      customerId,
      creditBalance: `£${balance} GBP`
    });
  } catch (err) {
    addLog(`Test email / credit failed: ${err.message}`, 'error');
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic SMTP & API verification endpoint
app.get('/api/verify-smtp', async (req, res) => {
  const host = process.env.SMTP_HOST || 'smtp.hostinger.com';
  const user = process.env.SMTP_USER || 'shop@thedentalshaman.com';
  const pass = process.env.SMTP_PASS;
  const resendApiKey = process.env.RESEND_API_KEY;

  const results = {};

  if (resendApiKey) {
    try {
      const apiCheck = await axios.get('https://api.resend.com/api-keys', {
        headers: { Authorization: `Bearer ${resendApiKey.trim()}` },
        timeout: 5000
      });
      results['resend_https_api'] = { status: 'SUCCESS', message: 'Resend HTTPS API authenticated and ready.' };
    } catch (e) {
      results['resend_https_api'] = { status: 'FAILED', error: e.response?.data?.message || e.message };
    }
  } else {
    results['resend_https_api'] = { status: 'NOT_CONFIGURED', note: 'RESEND_API_KEY env var not set. Using SMTP fallback.' };
  }

  for (const config of [{ port: 587, secure: false }, { port: 465, secure: true }]) {
    try {
      const t = nodemailer.createTransport({
        host,
        port: config.port,
        secure: config.secure,
        auth: { user, pass },
        tls: { rejectUnauthorized: false },
        connectionTimeout: 6000,
        greetingTimeout: 6000,
        socketTimeout: 6000
      });
      await t.verify();
      results[`port_${config.port}`] = { status: 'SUCCESS', secure: config.secure };
    } catch (e) {
      results[`port_${config.port}`] = { status: 'FAILED', error: e.message };
    }
  }
  res.json({ results, host, user });
});

// Start Batch
app.post('/api/start', (req, res) => {
  if (state.customers.length === 0) {
    return res.status(400).json({ error: 'No customers loaded. Please sync customers first.' });
  }
  if (state.isSending) {
    return res.json({ message: 'Batch already running.' });
  }
  runBatch().catch(err => {
    addLog(`Batch error: ${err.message}`, 'error');
  });
  res.json({ success: true, message: 'Batch started.' });
});

// Pause Batch
app.post('/api/pause', (req, res) => {
  state.isPaused = true;
  addLog('Batch paused by user.', 'warn');
  broadcast('progress', getStats());
  res.json({ success: true, message: 'Batch paused.' });
});

// Resume Batch
app.post('/api/resume', (req, res) => {
  state.isPaused = false;
  addLog('Batch resumed by user.', 'info');
  broadcast('progress', getStats());
  res.json({ success: true, message: 'Batch resumed.' });
});

// Stop Batch
app.post('/api/stop', (req, res) => {
  state.isSending = false;
  state.isPaused = false;
  addLog('Batch stop requested.', 'warn');
  broadcast('progress', getStats());
  res.json({ success: true, message: 'Batch stopped.' });
});

// Retry Failed Only
app.post('/api/retry-failed', (req, res) => {
  let count = 0;
  state.customers.forEach(c => {
    if (c.status === 'failed') {
      c.status = 'pending';
      c.error = null;
      count++;
    }
  });
  saveRecords();
  addLog(`Reset ${count} failed customers to pending for retry.`, 'info');
  broadcast('state_update', getStats());

  if (!state.isSending) {
    runBatch().catch(err => addLog(`Retry error: ${err.message}`, 'error'));
  }
  res.json({ success: true, count });
});

app.listen(PORT, async () => {
  console.log(`=======================================================`);
  console.log(`  The Dental Shaman £10 Store Credit Distribution App  `);
  console.log(`  Running on http://localhost:${PORT}                  `);
  console.log(`=======================================================`);
  addLog(`App started on http://localhost:${PORT}`, 'info');

  // If no customers yet, auto-fetch from Shopify
  if (state.customers.length === 0) {
    fetchAllShopifyCustomers().catch(err => {
      addLog(`Initial customer fetch error: ${err.message}`, 'error');
    });
  }
});
