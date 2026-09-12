// Cloudflare Pages Function: GET /api/audit?url=<site>
// Calls Google PageSpeed Insights (real Lighthouse) and returns honest findings.
// PSI API key is read from the PSI_API_KEY Worker secret (optional — PSI works
// keyless too, but a key avoids rate limits). Never hard-code the key.

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
  ['performance', 'seo', 'best-practices'].forEach(c => api.searchParams.append('category', c));
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
  const perfScore = Math.round(((cats.performance?.score) ?? 0) * 100);
  const seoScore = Math.round(((cats.seo?.score) ?? 0) * 100);

  const num = (id) => audits[id]?.numericValue;
  const passed = (id) => (audits[id]?.score ?? 0) >= 0.9;

  const findings = [];

  // Load time (Largest Contentful Paint, mobile)
  const lcp = num('largest-contentful-paint');
  if (lcp != null) {
    const secs = (lcp / 1000).toFixed(1);
    if (lcp > 4000)
      findings.push({ level: 'bad', title: `Loads in ${secs}s on mobile`,
        detail: '53% of visitors abandon a site that takes over 3 seconds. You may be losing most of your traffic before they read a word.' });
    else if (lcp > 2500)
      findings.push({ level: 'warn', title: `Loads in ${secs}s on mobile`,
        detail: 'Above the 2.5s mark Google considers "good." Faster load directly lifts conversions and search ranking.' });
    else
      findings.push({ level: 'good', title: `Loads in ${secs}s on mobile`,
        detail: 'Solid load speed. This is where you want to be.' });
  }

  // HTTPS / SSL
  if (passed('is-on-https'))
    findings.push({ level: 'good', title: 'Secure HTTPS connection', detail: 'Your site has a valid SSL certificate — good.' });
  else
    findings.push({ level: 'bad', title: 'No secure HTTPS connection',
      detail: 'Browsers mark your site "Not Secure," Google buries it, and customers hesitate to trust it.' });

  // Meta description (SEO)
  if (audits['meta-description'] && (audits['meta-description'].score ?? 0) < 1)
    findings.push({ level: 'warn', title: 'Missing or weak meta description',
      detail: 'Google is guessing what your business does — that guess is part of why you rank lower than you should.' });

  // Mobile viewport / tap targets
  if (audits['viewport'] && (audits['viewport'].score ?? 0) < 1)
    findings.push({ level: 'bad', title: 'Not mobile-friendly',
      detail: 'No proper mobile viewport — text and buttons break on phones, where most of your visitors actually are.' });

  // Overall SEO
  if (seoScore < 80)
    findings.push({ level: seoScore < 50 ? 'bad' : 'warn', title: `SEO health: ${seoScore}/100`,
      detail: 'Search engines are having trouble understanding and ranking your pages. Fixable, and high-leverage.' });

  // If almost nothing is wrong, say so honestly
  if (!findings.some(f => f.level === 'bad'))
    findings.push({ level: 'good', title: 'Foundation is in good shape',
      detail: 'The fundamentals hold up. There may still be room to sharpen design, copy, and conversion.' });

  // Overall health = performance-weighted, honest
  const score = Math.round(perfScore * 0.6 + seoScore * 0.4);

  return json({ url: host, score, perfScore, seoScore, findings });
}
