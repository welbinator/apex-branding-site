// Cloudflare Pages Function: GET /api/audit?url=<site>
// Deep audit via Google PageSpeed Insights (real Lighthouse + CrUX field data).
// Returns category scores, Core Web Vitals (lab + real-user), fix opportunities
// with concrete savings, and honest pass/fail findings. Key from PSI_API_KEY secret.

export async function onRequestGet({ request, env }) {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });

  const reqUrl = new URL(request.url);
  let target = (reqUrl.searchParams.get('url') || '').trim();
  if (!target) return json({ error: 'Missing url' }, 400);
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

  let host;
  try { host = new URL(target).hostname; }
  catch { return json({ error: 'Invalid url' }, 400); }

  const api = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  api.searchParams.set('url', target);
  api.searchParams.set('strategy', 'mobile');
  ['performance', 'seo', 'accessibility', 'best-practices'].forEach(c =>
    api.searchParams.append('category', c));
  if (env.PSI_API_KEY) api.searchParams.set('key', env.PSI_API_KEY);

  let psi;
  try {
    const r = await fetch(api.toString(), { cf: { cacheTtl: 300 } });
    if (!r.ok) return json({ error: 'audit-service-' + r.status }, 502);
    psi = await r.json();
  } catch (e) {
    return json({ error: 'audit-fetch-failed' }, 502);
  }

  const lh = psi.lighthouseResult;
  if (!lh) return json({ error: 'no-lighthouse-data' }, 502);

  const audits = lh.audits || {};
  const cats = lh.categories || {};
  const pct = (s) => (s == null ? null : Math.round(s * 100));
  const level = (n) => (n == null ? 'warn' : n >= 90 ? 'good' : n >= 50 ? 'warn' : 'bad');

  // ---- 1. Category scores ----
  const categories = [
    ['Performance', 'performance'],
    ['SEO', 'seo'],
    ['Accessibility', 'accessibility'],
    ['Best Practices', 'best-practices'],
  ].map(([label, key]) => {
    const s = pct(cats[key]?.score);
    return { label, score: s, level: level(s) };
  });

  const perfScore = categories[0].score ?? 0;
  const seoScore = categories[1].score ?? 0;

  // ---- 2. Core Web Vitals (lab data from Lighthouse) ----
  const metricLevel = (id) => {
    const s = audits[id]?.score;
    return s == null ? 'warn' : s >= 0.9 ? 'good' : s >= 0.5 ? 'warn' : 'bad';
  };
  const disp = (id) => audits[id]?.displayValue || null;
  const vitals = [
    { key: 'largest-contentful-paint', name: 'Largest Contentful Paint', help: 'How fast the main content appears' },
    { key: 'total-blocking-time', name: 'Total Blocking Time', help: 'How long the page is frozen to taps' },
    { key: 'cumulative-layout-shift', name: 'Cumulative Layout Shift', help: 'How much the page jumps around while loading' },
    { key: 'first-contentful-paint', name: 'First Contentful Paint', help: 'How fast anything first shows up' },
    { key: 'speed-index', name: 'Speed Index', help: 'How quickly the page looks complete' },
  ].filter(v => audits[v.key])
   .map(v => ({ name: v.name, value: disp(v.key), level: metricLevel(v.key), help: v.help }));

  // ---- 3. Real-user field data (CrUX), if Google has enough traffic on the site ----
  const fieldRaw = psi.loadingExperience?.metrics || {};
  const fieldMap = {
    LARGEST_CONTENTFUL_PAINT_MS: { name: 'Real LCP', unit: 'ms' },
    INTERACTION_TO_NEXT_PAINT: { name: 'Real INP', unit: 'ms' },
    CUMULATIVE_LAYOUT_SHIFT_SCORE: { name: 'Real CLS', unit: '' },
    FIRST_CONTENTFUL_PAINT_MS: { name: 'Real FCP', unit: 'ms' },
  };
  const field = Object.entries(fieldMap)
    .filter(([k]) => fieldRaw[k])
    .map(([k, meta]) => {
      const m = fieldRaw[k];
      const cat = m.category; // FAST | AVERAGE | SLOW
      const lvl = cat === 'FAST' ? 'good' : cat === 'AVERAGE' ? 'warn' : 'bad';
      let value = m.percentile;
      let display = meta.unit === 'ms'
        ? (value / 1000).toFixed(1) + 's'
        : (value / 100).toFixed(2);
      return { name: meta.name, value: display, level: lvl };
    });
  const hasField = field.length > 0;

  // ---- 4. Fix opportunities with concrete savings (sorted by impact) ----
  const fmtBytes = (b) => b >= 1024 * 1024
    ? (b / 1048576).toFixed(1) + ' MB'
    : Math.round(b / 1024) + ' KB';
  const opportunities = Object.values(audits)
    .filter(a => a.details?.type === 'opportunity' && (a.details.overallSavingsMs > 100 || a.details.overallSavingsBytes > 20480))
    .map(a => {
      const ms = a.details.overallSavingsMs || 0;
      const bytes = a.details.overallSavingsBytes || 0;
      const parts = [];
      if (ms > 100) parts.push((ms / 1000).toFixed(1) + 's faster');
      if (bytes > 20480) parts.push(fmtBytes(bytes) + ' smaller');
      return { title: a.title, savings: parts.join(' · '), _sort: ms + bytes / 100 };
    })
    .sort((a, b) => b._sort - a._sort)
    .slice(0, 6)
    .map(({ title, savings }) => ({ title, savings }));

  // ---- 5. Honest pass/fail findings ----
  const passed = (id) => (audits[id]?.score ?? 0) >= 0.9;
  const findings = [];
  if (passed('is-on-https'))
    findings.push({ level: 'good', title: 'Secure HTTPS connection', detail: 'Valid SSL certificate in place.' });
  else
    findings.push({ level: 'bad', title: 'No secure HTTPS connection', detail: 'Browsers flag your site "Not Secure," Google buries it, and customers hesitate to trust it.' });

  if (audits['viewport'] && (audits['viewport'].score ?? 0) < 1)
    findings.push({ level: 'bad', title: 'Not mobile-friendly', detail: 'No proper mobile viewport — layout breaks on phones, where most visitors are.' });

  if (audits['meta-description'] && (audits['meta-description'].score ?? 0) < 1)
    findings.push({ level: 'warn', title: 'Missing or weak meta description', detail: 'Google is guessing what your business does — that guess hurts your ranking.' });

  if (audits['document-title'] && (audits['document-title'].score ?? 0) < 1)
    findings.push({ level: 'warn', title: 'Missing or weak page title', detail: 'Your page title is the #1 thing Google and searchers read. It needs to be clear and keyword-aware.' });

  if (audits['image-alt'] && (audits['image-alt'].score ?? 0) < 1)
    findings.push({ level: 'warn', title: 'Images missing alt text', detail: 'Hurts accessibility and image SEO — Google can\'t "see" what your photos show.' });

  if (audits['color-contrast'] && (audits['color-contrast'].score ?? 0) < 1)
    findings.push({ level: 'warn', title: 'Low color contrast', detail: 'Some text is hard to read — fails accessibility standards and loses customers with low vision.' });

  if (audits['structured-data'] || audits['is-crawlable']) {
    if (audits['is-crawlable'] && (audits['is-crawlable'].score ?? 1) < 1)
      findings.push({ level: 'bad', title: 'Page blocked from Google', detail: 'Your site is telling search engines not to index it — it may be invisible in search entirely.' });
  }

  // Total page weight (diagnostic)
  const weight = audits['total-byte-weight']?.numericValue;
  if (weight) {
    const lvl = weight > 4 * 1048576 ? 'bad' : weight > 2 * 1048576 ? 'warn' : 'good';
    if (lvl !== 'good')
      findings.push({ level: lvl, title: `Heavy page: ${fmtBytes(weight)} to load`, detail: 'Large pages drain mobile data and load slowly on weaker connections — a real problem for local customers on their phones.' });
  }

  if (!findings.some(f => f.level === 'bad') && opportunities.length === 0)
    findings.push({ level: 'good', title: 'Technical foundation is solid', detail: 'The fundamentals hold up. The opportunity now is design, copy, and conversion — turning visitors into calls.' });

  const score = Math.round(perfScore * 0.5 + seoScore * 0.25 +
    (categories[2].score ?? 0) * 0.125 + (categories[3].score ?? 0) * 0.125);

  return json({
    url: host, score, categories, vitals, field, hasField, opportunities, findings,
    strategy: 'mobile',
  });
}
