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

// =======================
// Endpoint OTC
// =======================
app.get("/api/otc", async (req, res) => {
  try {
    const { from, to } = req.query;

    // 👉 AJUSTA ESTE ENDPOINT si usas otro de Lodgify
    const data = await lodgifyFetch(
      `/v1/reservation/bookings?from=${from}&to=${to}&limit=100`
    );

    const bookings = data.items || [];

    const rows = bookings.flatMap(b => {
      const base = {
        Id: b.id,
        Source: b.source,
        SourceText: b.sourceText,
        ChannelBooking: b.channel,
        Status: b.status,
        DateCancelled: b.dateCancelled || "",
        DateArrival: b.arrival,
        DateDeparture: b.departure,
        Nights: b.nights,
        HouseName: b.propertyName,
        HouseId: b.propertyId,
        RoomTypeNames: b.roomTypeNames || "",
        RoomTypeIds: b.roomTypeIds || "",
        GuestName: b.guest?.name || "",
        GuestEmail: b.guest?.email || "",
        NumberOfGuests: b.guests?.total || "",
        Adults: b.guests?.adults || "",
        Children: b.guests?.children || "",
        Infants: b.guests?.infants || "",
        Pets: b.guests?.pets || "",
        Currency: b.currency
      };

      const items = b.financial?.lineItems || [];

      if (!items.length) {
        return [{
          ...base,
          LineItem: "Total",
          LineItemDescription: "Total booking",
          GrossAmount: b.total,
          NetAmount: "",
          VatAmount: ""
        }];
      }

      return items.map(li => ({
        ...base,
        LineItem: li.code || li.type,
        LineItemDescription: li.description,
        GrossAmount: li.grossAmount,
        NetAmount: li.netAmount,
        VatAmount: li.vatAmount
      }));
    });

    res.json({ ok: true, count: rows.length, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () =>
  console.log(`✅ Server corriendo en http://localhost:${PORT}`)
);
