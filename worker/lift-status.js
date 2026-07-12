// Cloudflare Worker: scrapes NSW ski resorts' public lift/trail status pages
// and serves normalized JSON with CORS enabled, so a static page's client-side
// JS (blocked by CORS if it called the resort sites directly) can read it.
//
// Routing:  GET /perisher   or   GET /thredbo   (also accepts ?resort=perisher)
// Each resort is edge-cached for 5 minutes to stay light on the source servers.
//
// Parse approach mirrors the open-source Liftie project (BSD-3-Clause): both
// resorts expose per-lift status as an <img alt="Open|Closed|..."> next to a
// name, so we read those. If a resort restructures its page, update the parse
// function below (and check Liftie's repo — they often fix selectors first).

const CACHE_TTL_SECONDS = 300;

const RESORTS = {
  perisher: {
    name: "Perisher",
    url: "https://www.perisher.com.au/reports-cams/reports/lift-report",
    parse: parsePerisher
  },
  thredbo: {
    name: "Thredbo",
    url: "https://www.thredbo.com.au/weather/lifts-trails/",
    parse: parseThredbo
  }
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const key = (url.searchParams.get("resort") ||
      url.pathname.replace(/^\/+|\/+$/g, "")).toLowerCase();
    const resort = RESORTS[key];
    if (!resort) {
      return json({ ok: false, error: `unknown resort '${key}'; try /perisher or /thredbo` }, 404);
    }

    const cache = caches.default;
    const cacheKey = new Request("https://cache.internal/lift-status/" + key);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    let body;
    try {
      const upstream = await fetch(resort.url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; ski-info-proxy/1.0; +personal, non-commercial)"
        }
      });
      if (!upstream.ok) throw new Error("upstream HTTP " + upstream.status);
      const html = await upstream.text();
      const parsed = resort.parse(html);
      if (!parsed.lifts || parsed.lifts.total === 0) {
        throw new Error("parse yielded no lifts — page structure may have changed");
      }
      body = { ok: true, resort: key, name: resort.name, fetchedAt: new Date().toISOString(), ...parsed };
    } catch (err) {
      body = { ok: false, resort: key, error: String(err), fetchedAt: new Date().toISOString() };
    }

    const response = json(body, body.ok ? 200 : 502);
    if (body.ok) await cache.put(cacheKey, response.clone());
    return response;
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  };
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
      ...corsHeaders()
    }
  });
}

function decodeEntities(s) {
  return s
    .replace(/&#8217;/g, "'").replace(/&#039;/g, "'").replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").trim();
}

// --- Perisher: /reports-cams/reports/lift-report -------------------------
// Two <div class="lift_key"> summary rows (Open/Closed/Busy/On Hold/On Standby),
// then one <table> per mountain area with <img class="lift_image" alt="..."> rows.
function parsePerisher(html) {
  let open = 0, total = 0;
  const summaryBlock = html.match(/<div class="lift_key"[^>]*>[\s\S]*?<\/div>\s*<div class="lift_key"[^>]*>[\s\S]*?<\/div>/);
  if (summaryBlock) {
    const re = /alt="([^"]+)"[^>]*>\s*([A-Za-z ]+?):\s*(\d+)/g;
    let m;
    while ((m = re.exec(summaryBlock[0])) !== null) {
      const n = parseInt(m[3], 10);
      total += n;
      if (m[2].trim().toLowerCase() === "open") open = n;
    }
  }

  const detail = [];
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/g;
  let t;
  while ((t = tableRe.exec(html)) !== null) {
    const tableHtml = t[1];
    let group = null;
    const items = [];
    const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
    let row;
    while ((row = rowRe.exec(tableHtml)) !== null) {
      const rowHtml = row[1];
      const header = rowHtml.match(/<td colspan="2"[^>]*>([^<]+)</);
      if (header) { group = decodeEntities(header[1]); continue; }
      const status = rowHtml.match(/class="lift_image"[^>]*alt="([^"]+)"/);
      const cells = [...rowHtml.matchAll(/<td[^>]*>(?:<img[^>]*>)?([^<]*)<\/td>/g)].map(c => decodeEntities(c[1]));
      if (status && cells.length >= 3) {
        items.push({
          name: cells[0] || cells[1] || "",
          status: status[1],
          hours: cells[cells.length - 2] && cells[cells.length - 1]
            ? `${cells[cells.length - 2]} - ${cells[cells.length - 1]}` : null
        });
      }
    }
    if (group && items.length) detail.push({ group, items });
  }

  return { lifts: { open, total }, trails: null, detail };
}

// --- Thredbo: /weather/lifts-trails/ -------------------------------------
// Four <div class="status-list-block"> sections in order:
//   0 Winter Lifts | 1 Winter Trails | 2 Village Status | 3 Terrain Parks
// Each has <div class="status-block"> with .name and an <img alt="status">.
function parseThredbo(html) {
  const starts = [...html.matchAll(/<div class="status-list-block/g)].map(m => m.index);
  starts.push(html.length);

  function parseSection(seg) {
    const items = [];
    const re = /<div class="status-block">([\s\S]*?)(?=<div class="status-block">|<div class="status-list-block|$)/g;
    let m;
    while ((m = re.exec(seg)) !== null) {
      const chunk = m[1];
      const name = chunk.match(/<div class="name">([^<]+)<\/div>/);
      const hours = chunk.match(/<div class="working-hours">\(([^)]+)\)<\/div>/);
      const status = chunk.match(/<img[^>]*alt="([^"]*)"/);
      if (name) {
        const st = status && status[1].trim() ? status[1].trim() : "Unknown";
        items.push({ name: decodeEntities(name[1]), status: st, hours: hours ? decodeEntities(hours[1]) : null });
      }
    }
    return items;
  }

  const liftItems = starts.length > 1 ? parseSection(html.slice(starts[0], starts[1])) : [];
  const trailItems = starts.length > 2 ? parseSection(html.slice(starts[1], starts[2])) : [];

  const isOpen = s => { const x = s.toLowerCase(); return x === "open" || x === "groomed"; };
  const lifts = {
    open: liftItems.filter(l => l.status.toLowerCase() === "open").length,
    total: liftItems.length
  };
  const trails = trailItems.length
    ? { open: trailItems.filter(t => isOpen(t.status)).length, total: trailItems.length }
    : null;

  return { lifts, trails, detail: [{ group: "Winter Lifts", items: liftItems }] };
}
