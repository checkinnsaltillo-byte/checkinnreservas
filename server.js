import express from "express";
import cors from "cors";
import path from "path";

const app = express();
const __dirname = path.resolve();

// Body
app.use(express.json({ limit: "2mb" }));

// -------------------- CORS --------------------
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOW_NULL_ORIGIN =
  (process.env.ALLOW_NULL_ORIGIN || "true").toLowerCase() === "true";

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOW_NULL_ORIGIN && origin === "null") return cb(null, true);
      if (!allowedOrigins.length) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
  })
);

// Static
// -------------------- Static --------------------
// Sirve /public como estáticos
app.use(express.static(path.join(__dirname, "public")));

// -------------------- ENV --------------------
const LODGIFY_API_KEY =
  process.env.LODGIFY_API_KEY ||
  process.env.lodgify_api_key ||
  process.env.LODGIFY_APIKEY ||
  "";

const LODGIFY_BASE = (process.env.LODGIFY_BASE || "https://api.lodgify.com").replace(/\/+$/, "");
const LODGIFY_BASE = (process.env.LODGIFY_BASE || "https://api.lodgify.com").replace(
  /\/+$/,
  ""
);

function requireApiKey() {
  if (!LODGIFY_API_KEY) {
    const e = new Error("Missing Lodgify API key. Set env var LODGIFY_API_KEY");
    // @ts-ignore
    e.statusCode = 500;
    throw e;
  }
}

async function lodgifyFetch(p, { method = "GET", headers = {}, body } = {}) {
  requireApiKey();
  const url = `${LODGIFY_BASE}${p.startsWith("/") ? "" : "/"}${p}`;

  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-ApiKey": LODGIFY_API_KEY,
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const txt = await res.text();
  let data = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    data = { raw: txt };
  }

  if (!res.ok) {
    const msg =
      typeof data === "object" && data
        ? (data.message || data.error || JSON.stringify(data))
        ? data.message || data.error || JSON.stringify(data)
        : String(txt);
    const err = new Error(`Lodgify ${res.status}: ${msg}`);
    // @ts-ignore
    err.statusCode = res.status;
    throw err;
  }

  return data;
}

// -------------------- Helpers --------------------
function parseISODate(s) {
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}
function formatMMDDYYYY(d) {
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${mm}/${dd}/${yyyy}`;
}
function nights(arrivalISO, departureISO) {
  const a = new Date(`${arrivalISO}T00:00:00Z`);
  const b = new Date(`${departureISO}T00:00:00Z`);
  return Math.max(0, Math.round((b - a) / (1000 * 60 * 60 * 24)));
}
function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}
function guessSourceLabel(b) {
  const src = (b?.source || "").toLowerCase();
  if (src.includes("airbnb")) return "Airbnb";
  if (src.includes("booking")) return "Booking.com";
  if (src.includes("vrbo")) return "Vrbo";
  if (src.includes("manual")) return "Manual";
  return b?.source || "Unknown";
}

function overlaps(arrivalISO, departureISO, fromISO, toISO) {
  const a = new Date(`${arrivalISO}T00:00:00Z`);
  const d = new Date(`${departureISO}T00:00:00Z`);
  const from = new Date(`${fromISO}T00:00:00Z`);
  const to = new Date(`${toISO}T00:00:00Z`);
  to.setUTCDate(to.getUTCDate() + 1); // inclusivo
  return a < to && d > from;
}

function clampNightsWithinRange(arrivalISO, departureISO, fromISO, toISO) {
  const a = new Date(`${arrivalISO}T00:00:00Z`);
  const d = new Date(`${departureISO}T00:00:00Z`);
  const from = new Date(`${fromISO}T00:00:00Z`);
  const toExclusive = new Date(`${toISO}T00:00:00Z`);
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);

  const start = a > from ? a : from;
  const end = d < toExclusive ? d : toExclusive;

  const ms = end - start;
  if (ms <= 0) return 0;
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function prorate(amount, totalNights, nightsInRange) {
  const x = safeNum(amount);
  if (!x) return 0;
  if (!totalNights || !nightsInRange) return 0;
  return (x * nightsInRange) / totalNights;
}

async function fetchPropertiesMap() {
  const attempts = ["/v2/properties", "/v1/properties"];
  for (const p of attempts) {
    try {
      const data = await lodgifyFetch(p);
      const items = Array.isArray(data) ? data : (data?.items || data?.properties || []);
      const items = Array.isArray(data)
        ? data
        : data?.items || data?.properties || [];
      const map = new Map();
      for (const it of items) {
        const id = it?.id ?? it?.property_id ?? it?.houseId;
        const name = it?.name ?? it?.title ?? it?.internal_name ?? it?.propertyName;
        const name =
          it?.name ?? it?.title ?? it?.internal_name ?? it?.propertyName;
        if (id != null) map.set(Number(id), String(name ?? id));
      }
      if (map.size) return map;
    } catch {}
    } catch {
      // try next
    }
  }
  return new Map();
}

// -------------------- ✅ Bookings fetch con page/size --------------------
function extractBatch(data) {
  const batch = data?.items || data?.bookings || (Array.isArray(data) ? data : []);
  if (!Array.isArray(batch)) throw new Error("Unexpected bookings payload shape");
  return batch;
}

function extractCount(data) {
  // con includeCount=true, Lodgify suele regresar algo tipo count/total
  const c = safeNum(data?.count) || safeNum(data?.total) || safeNum(data?.total_count) || safeNum(data?.totalBookings);
  return c > 0 ? c : null;
}

// -------------------- ✅ Bookings fetch con page/size (robusto) --------------------
/**
 * Trae TODO con stayFilter=All paginado por page/size
 * y luego tú filtras por overlaps() para el mes.
 * IMPORTANTE: includeQuoteDetails=true para tener subtotals/total_amount
 */
async function fetchAllBookings({ size = 200, stayFilter = "All" } = {}) {
  const bookings = [];
  let page = 1;
  let pagesUsed = 0;

  // Seguridad
  size = Math.min(200, Math.max(10, Number(size || 200)));

  let totalCount = null;

  while (true) {
    const qs = new URLSearchParams({
      page: String(page),
      size: String(size),
      includeCount: "true",
      stayFilter: stayFilter,              // All | Upcoming | Current | Historic | ArrivalDate | DepartureDate
      includeQuoteDetails: "true",         // <<< CLAVE: montos/subtotals completos
      // includeTransactions: "true",       // opcional (si quieres transacciones)
      // includeExternal: "true",           // opcional
      stayFilter: String(stayFilter),
      includeQuoteDetails: "true",
      // includeTransactions: "true", // opcional
      // includeExternal: "true",     // opcional
    });

    const data = await lodgifyFetch(`/v2/reservations/bookings?${qs.toString()}`);

    const batch = data?.items || data?.bookings || [];
    if (!Array.isArray(batch)) throw new Error("Unexpected bookings payload shape");

    bookings.push(...batch);
    pagesUsed++;

    // count/total (depende del shape)
    const count =
      safeNum(data?.count) ||
      safeNum(data?.total) ||
      safeNum(data?.total_count) ||
      safeNum(data?.totalBookings) ||
      null;

    if (count && !totalCount) totalCount = count;

    // Stop conditions:
    // Stop conditions
    if (batch.length < size) break; // última página
    if (totalCount && bookings.length >= totalCount) break;

    page++;
    if (page > 10000) break; // guard anti-loop
  }

  return { bookings, totalCount: totalCount || bookings.length, pagesUsed };
}



// -------------------- OTC builder --------------------
function buildOTCRows({ bookings, propsMap, fromISO, toISO }) {
  const rows = [];

  for (const b of bookings) {
    if (!b?.arrival || !b?.departure) continue;
    if (!overlaps(b.arrival, b.departure, fromISO, toISO)) continue;

    const totalN = nights(b.arrival, b.departure);
    const nInRange = clampNightsWithinRange(b.arrival, b.departure, fromISO, toISO);
    if (!nInRange) continue;

    const a = new Date(`${b.arrival}T00:00:00Z`);
    const dep = new Date(`${b.departure}T00:00:00Z`);

    const houseId = Number(b.property_id);
    const houseName = propsMap.get(houseId) || String(houseId || "");

    const roomTypeIds = (b.rooms || []).map((r) => r.room_type_id).filter(Boolean);
    const guest = b.guest || {};
    const gb = (b.rooms && b.rooms[0] && b.rooms[0].guest_breakdown) || {};

    const base = {
      Id: b.id,
      Source: guessSourceLabel(b),
      SourceText: b.source_text || "",
      ChannelBooking: (typeof b.source_text === "string" && b.source_text.length <= 30) ? b.source_text : "",
      ChannelBooking:
        typeof b.source_text === "string" && b.source_text.length <= 30
          ? b.source_text
          : "",
      Status: b.status || "",
      DateCancelled: b.canceled_at ? formatMMDDYYYY(new Date(`${b.canceled_at}Z`)) : "",
      DateArrival: formatMMDDYYYY(a),
      DateDeparture: formatMMDDYYYY(dep),
      Nights: nInRange,
      HouseName: houseName,
      HouseId: houseId || "",
      RoomTypeNames: houseName,
      RoomTypeIds: roomTypeIds.join(","),
      GuestName: guest.name || "",
      GuestEmail: guest.email || "",
      NumberOfGuests: safeNum((b.rooms && b.rooms[0] && b.rooms[0].people) || 0),
      Adults: safeNum(gb.adults),
      Children: safeNum(gb.children),
      Infants: safeNum(gb.infants),
      Pets: safeNum(gb.pets),
      Currency: b.currency_code || "",
    };

    const st = b.subtotals || {};
    const stay = prorate(st.stay, totalN, nInRange);
    const fees = prorate(st.fees, totalN, nInRange);
    const taxes = prorate(st.taxes, totalN, nInRange);
    const addons = prorate(st.addons, totalN, nInRange);
    const promos = prorate(st.promotions, totalN, nInRange);
    const vat = prorate(st.vat, totalN, nInRange);

    const lineItems = [];
    if (stay) lineItems.push({ LineItem: "RoomRate", LineItemDescription: "Tarifa diaria", GrossAmount: stay });
    if (fees) lineItems.push({ LineItem: "Fee", LineItemDescription: "Fees", GrossAmount: fees });
    if (taxes) lineItems.push({ LineItem: "Tax", LineItemDescription: "Taxes", GrossAmount: taxes });
    if (addons) lineItems.push({ LineItem: "Addon", LineItemDescription: "Add-ons", GrossAmount: addons });
    if (promos) lineItems.push({ LineItem: "Promotion", LineItemDescription: "Promotions", GrossAmount: promos });
    if (vat) lineItems.push({ LineItem: "VAT", LineItemDescription: "VAT", GrossAmount: vat });

    // fallback
    if (!lineItems.length) {
      const total = prorate(b.total_amount, totalN, nInRange);
      if (total) lineItems.push({ LineItem: "Total", LineItemDescription: "Total", GrossAmount: total });
    }

    for (const li of lineItems) {
      const amt = Number(safeNum(li.GrossAmount).toFixed(2));
      rows.push({
        ...base,
        LineItem: li.LineItem,
        LineItemDescription: li.LineItemDescription,
        GrossAmount: amt,
        NetAmount: amt,
        VatAmount: 0,
      });
    }
  }

  return rows;
}

function rowsToCSV(rows) {
  const cols = [
    "Id","Source","SourceText","ChannelBooking","Status","DateCancelled",
    "DateArrival","DateDeparture","Nights","HouseName","HouseId",
    "RoomTypeNames","RoomTypeIds","GuestName","GuestEmail",
    "NumberOfGuests","Adults","Children","Infants","Pets","Currency",
    "LineItem","LineItemDescription","GrossAmount","NetAmount","VatAmount"
  ];

  const esc = (v) => {
    const s = (v ?? "").toString();
    if (/[",\n]/.test(s)) return `"${s.replaceAll('"','""')}"`;
    if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
    return s;
  };

  return [
    cols.join(","),
    ...rows.map((r) => cols.map((c) => esc(r[c])).join(",")),
  ].join("\n");
}

// -------------------- Routes --------------------
app.get("/health", (req, res) => res.json({ ok: true }));

// ✅ Debug: te dice el rango real que está regresando Lodgify y cuántas páginas usó
// ✅ Debug: compara sin/con includeQuoteDetails
app.get("/api/debug/bookings", async (req, res) => {
  try {
    const size = Math.min(200, Math.max(10, Number(req.query.size || 50)));
    const { bookings, totalCount, pagesUsed } = await fetchAllBookings({ size });

    const arrivals = bookings.map(b => b?.arrival).filter(Boolean).sort();
    const qsA = new URLSearchParams({
      page: "1",
      size: String(size),
      includeCount: "true",
      stayFilter: "All",
    });
    const a = await lodgifyFetch(`/v2/reservations/bookings?${qsA.toString()}`);
    const batchA = a?.items || a?.bookings || [];
    const totalA = safeNum(a?.count) || safeNum(a?.total) || null;

    const qsB = new URLSearchParams({
      page: "1",
      size: String(size),
      includeCount: "true",
      stayFilter: "All",
      includeQuoteDetails: "true",
    });
    const b = await lodgifyFetch(`/v2/reservations/bookings?${qsB.toString()}`);
    const batchB = b?.items || b?.bookings || [];
    const totalB = safeNum(b?.count) || safeNum(b?.total) || null;

    const pick = (x) => ({
      id: x?.id,
      arrival: x?.arrival,
      departure: x?.departure,
      status: x?.status,
      property_id: x?.property_id,
      total_amount: x?.total_amount,
      subtotals: x?.subtotals,
      currency: x?.currency_code,
    });

    const arrivals = (arr) => arr.map((o) => o?.arrival).filter(Boolean).sort();

    res.json({
      ok: true,
      endpointUsed: "/v2/reservations/bookings?page&size&stayFilter=All",
      size,
      totalCount,
      pagesUsed,
      bookingsFetched: bookings.length,
      arrivalMin: arrivals[0] || null,
      arrivalMax: arrivals[arrivals.length - 1] || null,
      sample: bookings.slice(0, 5).map(b => ({
        id: b?.id,
        arrival: b?.arrival,
        departure: b?.departure,
        status: b?.status,
        property_id: b?.property_id,
      })),
      noQuote: {
        endpointUsed: `/v2/reservations/bookings?${qsA.toString()}`,
        totalCount: totalA,
        sample: batchA.slice(0, 5).map(pick),
        arrivalMin: arrivals(batchA)[0] || null,
        arrivalMax: arrivals(batchA).slice(-1)[0] || null,
      },
      withQuote: {
        endpointUsed: `/v2/reservations/bookings?${qsB.toString()}`,
        totalCount: totalB,
        sample: batchB.slice(0, 5).map(pick),
        arrivalMin: arrivals(batchB)[0] || null,
        arrivalMax: arrivals(batchB).slice(-1)[0] || null,
      },
    });
  } catch (e) {
    const code = e?.statusCode ? Number(e.statusCode) : 500;
    res.status(code).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/otc", async (req, res) => {
  try {
    const fromISO = String(req.query.from || "");
    const toISO = String(req.query.to || "");
    if (!parseISODate(fromISO) || !parseISODate(toISO)) {
      return res.status(400).json({ ok: false, error: "Use ?from=YYYY-MM-DD&to=YYYY-MM-DD" });
    }

    const size = Math.min(200, Math.max(10, Number(req.query.size || req.query.limit || 200)));

    const [propsMap, pulled] = await Promise.all([
      fetchPropertiesMap(),
      fetchAllBookings({ size, stayFilter: "All" }),
    ]);

    const rows = buildOTCRows({ bookings: pulled.bookings, propsMap, fromISO, toISO });

    res.json({
      ok: true,
      from: fromISO,
      to: toISO,
      endpointUsed: "/v2/reservations/bookings?page&size&includeCount=true&stayFilter=All&includeQuoteDetails=true",
      endpointUsed:
        "/v2/reservations/bookings?page&size&includeCount=true&stayFilter=All&includeQuoteDetails=true",
      bookingsFetched: pulled.bookings.length,
      totalCount: pulled.totalCount,
      pagesUsed: pulled.pagesUsed,
      rowsCount: rows.length,
      rows,
    });
  } catch (e) {
    const code = e?.statusCode ? Number(e.statusCode) : 500;
    res.status(code).json({ ok: false, error: String(e?.message || e) });
  }
});


app.get("/api/otc.csv", async (req, res) => {
  try {
    const fromISO = String(req.query.from || "");
    const toISO = String(req.query.to || "");
    if (!parseISODate(fromISO) || !parseISODate(toISO)) {
      return res.status(400).send("Use ?from=YYYY-MM-DD&to=YYYY-MM-DD");
    }

    const size = Math.min(200, Math.max(10, Number(req.query.size || req.query.limit || 200)));

    const [propsMap, pulled] = await Promise.all([
      fetchPropertiesMap(),
      fetchAllBookings({ size, stayFilter: "All" }),
    ]);

    const rows = buildOTCRows({ bookings: pulled.bookings, propsMap, fromISO, toISO });
    const csv = rowsToCSV(rows);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="OTCReport_${fromISO}_to_${toISO}.csv"`);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="OTCReport_${fromISO}_to_${toISO}.csv"`
    );
    res.send(csv);
  } catch (e) {
    const code = e?.statusCode ? Number(e.statusCode) : 500;
    res.status(code).send(String(e?.message || e));
  }
});




// Home
// -------------------- Home --------------------
// Evita ENOENT: SIEMPRE sirve public/index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ checkinnreservas API running on port ${PORT}`);
