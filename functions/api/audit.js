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

  // ---- Tech stack + hosting (run alongside PSI, non-fatal) ----
  const [stack, hosting] = await Promise.all([
    detectStack(target).catch(() => []),
    detectHosting(host).catch(() => null),
  ]);

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
    stack, hosting,
    strategy: 'mobile',
  });
}

// ---- Technology stack detection ----
// Fingerprints from the site's own HTML + response headers. Honest: only
// reports what's actually observable, never guesses.
async function detectStack(target) {
  const res = await fetch(target, {
    redirect: 'follow',
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; SiteAuditBot/1.0)' },
  });
  const headers = res.headers;
  const html = (await res.text()).slice(0, 250000);
  const found = new Map(); // name -> category (dedupe)
  const add = (name, category) => { if (!found.has(name)) found.set(name, category); };

  const h = (k) => (headers.get(k) || '').toLowerCase();
  const has = (re) => re.test(html);

  // --- Server / platform from headers ---
  const server = h('server');
  const powered = h('x-powered-by');
  if (server.includes('cloudflare')) add('Cloudflare', 'CDN / Proxy');
  if (server.includes('nginx')) add('Nginx', 'Web server');
  if (server.includes('apache')) add('Apache', 'Web server');
  if (server.includes('litespeed')) add('LiteSpeed', 'Web server');
  if (server.includes('microsoft-iis')) add('IIS', 'Web server');
  if (server.includes('vercel') || h('x-vercel-id')) add('Vercel', 'Hosting / Platform');
  if (server.includes('netlify') || h('x-nf-request-id')) add('Netlify', 'Hosting / Platform');
  if (h('x-served-by').includes('cache') || h('via').includes('varnish')) add('Varnish / Fastly', 'CDN / Cache');
  if (powered.includes('php')) add('PHP', 'Language');
  if (powered.includes('asp.net')) add('ASP.NET', 'Framework');
  if (powered.includes('express')) add('Express', 'Framework');
  if (powered.includes('next')) add('Next.js', 'Framework');
  if (h('x-shopify-stage') || server.includes('shopify')) add('Shopify', 'E-commerce / CMS');
  if (h('x-github-request-id')) add('GitHub Pages', 'Hosting / Platform');
  if (h('x-wix-request-id') || has(/static\.wixstatic\.com/)) add('Wix', 'Website builder');
  if (h('x-squarespace') || has(/static1\.squarespace\.com|squarespace-cdn/)) add('Squarespace', 'Website builder');

  // --- CMS / frameworks from HTML ---
  if (has(/wp-content\/|wp-includes\/|<meta[^>]+WordPress/i)) add('WordPress', 'CMS');
  if (has(/\/sites\/default\/files\/|Drupal\.settings|drupal\.js/i)) add('Drupal', 'CMS');
  if (has(/\/media\/jui\/|Joomla!|\/components\/com_/i)) add('Joomla', 'CMS');
  if (has(/cdn\.shopify\.com|shopify\.theme/i)) add('Shopify', 'E-commerce / CMS');
  if (has(/data-astro-|\/_astro\//i)) add('Astro', 'Framework');
  if (has(/__NEXT_DATA__|\/_next\//i)) add('Next.js', 'Framework');
  if (has(/id="__nuxt"|\/_nuxt\//i)) add('Nuxt', 'Framework');
  if (has(/ng-version=|ng-app=/i)) add('Angular', 'Framework');
  if (has(/data-reactroot|react(?:-dom)?(?:\.production)?\.min\.js/i)) add('React', 'Library');
  if (has(/data-v-app|vue(?:\.runtime)?(?:\.global)?\.(?:prod\.)?js/i)) add('Vue', 'Library');
  if (has(/gatsby-|___gatsby/i)) add('Gatsby', 'Framework');
  if (has(/svelte-[0-9a-z]{5,}/i)) add('Svelte', 'Framework');
  if (has(/jquery(?:-|\.)[0-9]|jquery\.min\.js/i)) add('jQuery', 'Library');
  if (has(/cdn\.jsdelivr\.net\/npm\/bootstrap|class="[^"]*\b(?:col-md-|navbar-|btn-primary)\b/i)) add('Bootstrap', 'CSS framework');
  if (has(/\b(?:tw-|md:flex|text-gray-\d|bg-\w+-\d00)\b|tailwind/i)) add('Tailwind CSS', 'CSS framework');
  if (has(/elementor-|elementor\/assets/i)) add('Elementor', 'Page builder');
  if (has(/wpforms|contact-form-7|gravityforms/i)) add('WP Forms plugin', 'Plugin');
  if (has(/woocommerce/i)) add('WooCommerce', 'E-commerce');

  // --- Analytics / tags ---
  if (has(/googletagmanager\.com\/gtm/i)) add('Google Tag Manager', 'Tag manager');
  if (has(/gtag\/js|www\.google-analytics\.com|G-[A-Z0-9]{6,}/)) add('Google Analytics', 'Analytics');
  if (has(/static\.cloudflareinsights\.com/)) add('Cloudflare Analytics', 'Analytics');
  if (has(/connect\.facebook\.net|fbq\(/)) add('Meta Pixel', 'Marketing');
  if (has(/hotjar\.com|hj\(/)) add('Hotjar', 'Analytics');
  if (has(/plausible\.io/)) add('Plausible', 'Analytics');

  // --- Fonts / hosting hints ---
  if (has(/fonts\.googleapis\.com|fonts\.gstatic\.com/)) add('Google Fonts', 'Fonts');

  return Array.from(found, ([name, category]) => ({ name, category }));
}

// ---- Hosting / DNS lookup ----
// Resolves the hostname (Cloudflare DoH) then asks RDAP who owns the IP block,
// so we can honestly name the hosting network. All best-effort.
async function detectHosting(host) {
  const doh = async (name, type) => {
    const r = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
      { headers: { accept: 'application/dns-json' } }
    );
    if (!r.ok) return null;
    return r.json();
  };

  // Follow CNAME chain, collect A records
  const a = await doh(host, 'A');
  const answers = (a?.Answer || []);
  const cnames = answers.filter(x => x.type === 5).map(x => x.data.replace(/\.$/, ''));
  const ips = answers.filter(x => x.type === 1).map(x => x.data);
  if (!ips.length) return { host, ips: [], cnames, org: null, network: null, country: null };

  // Who owns the IP → hosting org/network, via Team Cymru's DNS-based
  // IP-to-ASN service (queried over DoH, so no HTTP rate limits). Two hops:
  // reversed-IP.origin.asn.cymru.com → ASN+country, then ASN.asn.cymru.com → org.
  let org = null, network = null, country = null;
  try {
    const ip = ips[0];
    const rev = ip.split('.').reverse().join('.');
    const o = await doh(`${rev}.origin.asn.cymru.com`, 'TXT');
    const otxt = (o?.Answer || []).map(x => x.data.replace(/^"|"$/g, ''))[0];
    if (otxt) {
      // "13335 | 104.21.64.0/20 | US | arin | 2014-03-28"
      const parts = otxt.split('|').map(s => s.trim());
      const asn = parts[0];
      country = parts[2] || null;
      if (asn) {
        network = 'AS' + asn;
        const n = await doh(`AS${asn}.asn.cymru.com`, 'TXT');
        const ntxt = (n?.Answer || []).map(x => x.data.replace(/^"|"$/g, ''))[0];
        if (ntxt) {
          // "13335 | US | arin | 2010-07-14 | CLOUDFLARENET - Cloudflare, Inc., US"
          const np = ntxt.split('|').map(s => s.trim());
          org = (np[4] || '').replace(/,\s*[A-Z]{2}$/, '').trim() || null;
        }
      }
    }
  } catch { /* best effort */ }

  // Clean the raw ASN org ("CLOUDFLARENET - Cloudflare, Inc." → "Cloudflare, Inc.")
  const orgClean = org && org.includes(' - ') ? org.split(' - ').slice(1).join(' - ').trim() : org;

  // Friendly provider name from CNAME / org text
  const hint = (cnames.join(' ') + ' ' + (org || '') + ' ' + (network || '')).toLowerCase();
  let provider = orgClean || null;
  const map = [
    ['pages.dev', 'Cloudflare Pages'], ['cloudflare', 'Cloudflare'],
    ['vercel', 'Vercel'], ['netlify', 'Netlify'], ['github.io|github', 'GitHub'],
    ['amazonaws|aws|ec2|amazon', 'Amazon AWS'], ['google|gcp|1e100', 'Google Cloud'],
    ['azure|microsoft', 'Microsoft Azure'], ['digitalocean', 'DigitalOcean'],
    ['hetzner', 'Hetzner'], ['ovh', 'OVH'], ['linode', 'Linode'], ['akamai', 'Akamai'],
    ['fastly', 'Fastly'], ['squarespace', 'Squarespace'], ['wix', 'Wix'],
    ['shopify', 'Shopify'], ['godaddy|secureserver', 'GoDaddy'],
    ['bluehost|hostgator|newfold', 'Bluehost / Newfold'], ['siteground', 'SiteGround'],
    ['wpengine', 'WP Engine'], ['kinsta', 'Kinsta'],
  ];
  for (const [re, label] of map) {
    if (new RegExp(re).test(hint)) { provider = label; break; }
  }

  return { host, ips, cnames, org: orgClean, network, country, provider };
}
