import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const LODGIFY_API_KEY = process.env.LODGIFY_API_KEY;

if (!LODGIFY_API_KEY) {
  console.error("❌ Falta LODGIFY_API_KEY en variables de entorno");
}

const BASE_URL = "https://api.lodgify.com";

// =======================
// Helper Lodgify
// =======================
async function lodgifyFetch(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      "Accept": "application/json",
      "X-ApiKey": LODGIFY_API_KEY
    }
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Lodgify ${res.status}: ${t}`);
  }
  return res.json();
}

app.get("/", (req, res) => {
  res.status(200).send("✅ checkinnreservas API running. Try /health or /api/otc");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});


// =======================
// Endpoint OTC
// =======================
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const LODGIFY_API_KEY = process.env.LODGIFY_API_KEY;

const LODGIFY_BASE = "https://api.lodgify.com";

async function lodgifyFetch(pathWithQuery) {
  const url = `${LODGIFY_BASE}${pathWithQuery}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-ApiKey": LODGIFY_API_KEY,
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Lodgify ${res.status}: ${txt || ""}`.trim());
  }
  return res.json();
}

// ✅ Ruta home para que no diga "Cannot GET /"
app.get("/", (req, res) => res.send("✅ checkinnreservas API running"));

// ✅ Prueba rápida de API key contra un endpoint seguro
app.get("/api/_ping", async (req, res) => {
  try {
    const data = await lodgifyFetch("/v1/countries"); // existe en docs
    res.json({ ok: true, sampleCount: Array.isArray(data) ? data.length : null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ⚠️ Este ejemplo lista bookings (v2). Los parámetros exactos de filtro/paginación
// pueden variar; primero haz que responda y luego afinamos filtros.
app.get("/api/otc", async (req, res) => {
  try {
    // 1) Lista bookings (v2)
    // Si quieres “todos” sin filtro: así.
    const bookingsList = await lodgifyFetch("/v2/reservations/bookings");

    // OJO: la estructura exacta puede ser {items:[...]} u otra.
    const bookings = Array.isArray(bookingsList?.items)
      ? bookingsList.items
      : (Array.isArray(bookingsList) ? bookingsList : []);

    // 2) (Opcional) si necesitas detalles completos por booking:
    //    pedimos /v1/reservation/booking/{id}
    const detailed = [];
    for (const b of bookings.slice(0, 200)) { // límite de seguridad
      const id = b.id ?? b.bookingId;
      if (!id) continue;
      try {
        const det = await lodgifyFetch(`/v1/reservation/booking/${encodeURIComponent(id)}`);
        detailed.push(det);
      } catch {
        // si alguno falla, lo saltamos
      }
    }

    res.json({
      ok: true,
      count_list: bookings.length,
      count_details: detailed.length,
      list_sample: bookings.slice(0, 3),
      details_sample: detailed.slice(0, 1),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.listen(PORT, () => console.log(`✅ Server on :${PORT}`));

