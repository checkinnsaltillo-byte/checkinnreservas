import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Cloud Run SIEMPRE expone el puerto en process.env.PORT
const PORT = Number(process.env.PORT || 8080);

// ✅ OJO: variables de entorno son case-sensitive
const LODGIFY_API_KEY = process.env.LODGIFY_API_KEY || process.env.lodgify_api_key || "";

const LODGIFY_BASE = "https://api.lodgify.com";

// ✅ Home + health para que Cloud Run vea vida inmediatamente
app.get("/", (req, res) => res.status(200).send("✅ checkinnreservas API running"));
app.get("/health", (req, res) => res.json({ ok: true }));

async function lodgifyFetch(pathWithQuery) {
  if (!LODGIFY_API_KEY) {
    throw new Error("Missing LODGIFY_API_KEY env var");
  }

  const url = `${LODGIFY_BASE}${pathWithQuery}`;
  const r = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-ApiKey": LODGIFY_API_KEY,
    },
  });

  // Lodgify a veces responde 204/empty en algunos endpoints; manejamos texto
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Lodgify ${r.status}: ${txt}`.trim());
  }

  const ct = r.headers.get("content-type") || "";
  if (ct.includes("application/json")) return r.json();
  const txt = await r.text();
  return txt;
}

// ✅ Ping a Lodgify (para confirmar key)
app.get("/api/_ping", async (req, res) => {
  try {
    // Endpoint documentado
    const data = await lodgifyFetch("/v1/countries");
    res.json({ ok: true, sampleCount: Array.isArray(data) ? data.length : null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ✅ (Temporal) probador de bookings: primero haz que responda
app.get("/api/bookings", async (req, res) => {
  try {
    const data = await lodgifyFetch("/v2/reservations/bookings");
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/otc", async (req, res) => {
  try {
    const { from, to } = req.query;

    // 1️⃣ Traer reservas (v2)
    const data = await lodgifyFetch("/v2/reservations/bookings");

    // Lodgify suele devolver { items: [...] }
    const bookings = Array.isArray(data?.items) ? data.items : [];

    // 2️⃣ Devolver muestra + conteo
    res.json({
      ok: true,
      from,
      to,
      total_bookings: bookings.length,
      sample_booking: bookings[0] || null,
      bookings
    });

  } catch (e) {
    res.status(500).json({
      ok: false,
      error: String(e.message || e)
    });
  }
});


// ✅ Importante: escuchar en 0.0.0.0 y en PORT
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Listening on ${PORT}`);
});
