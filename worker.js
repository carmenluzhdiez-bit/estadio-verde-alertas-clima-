// ─────────────────────────────────────────────────────────────────────────
// Cloudflare Worker — Alertas automáticas de Viento y Radiación UV
// Estadio Español · Departamento de Áreas Verdes
//
// Corre solo (cron programado), sin depender de que alguien tenga la app
// abierta. Revisa Open-Meteo cada vez que se dispara, y si el viento llega a
// Nivel 2+ (60+ km/h) o el UV llega a 6+ (Alto), avisa por:
//   1) Push a todos los dispositivos con notificaciones activadas.
//   2) Notificación visible en el feed compartido de la app (🔔 Registros).
// No repite el mismo aviso el mismo día, salvo que suba de categoría.
// ─────────────────────────────────────────────────────────────────────────

const DB_URL = "https://riego-estadio-espanol-default-rtdb.firebaseio.com";
const ROOT = "estadio-verde-data";
const LAT = -33.4127;
const LON = -70.5775;
const HORA_INICIO = 7;  // horario laboral — desde las 07:00 (hora Chile)
const HORA_FIN = 19;    // hasta las 19:00 (hora Chile), inclusive

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(chequearClima(env));
  },
  async fetch(request, env, ctx) {
    // Endpoint manual de prueba: visitar la URL del Worker con ?test=1
    const url = new URL(request.url);
    if (url.searchParams.get("test") === "1") {
      const resultado = await chequearClima(env, true);
      return new Response(JSON.stringify(resultado, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Worker de alertas de clima — Estadio Español. Activo.", { status: 200 });
  },
};

async function chequearClima(env, forzarFueraHorario = false) {
  const horaChile = parseInt(
    new Intl.DateTimeFormat("en-US", { hour: "2-digit", hour12: false, timeZone: "America/Santiago" }).format(new Date())
  );
  if (!forzarFueraHorario && (horaChile < HORA_INICIO || horaChile >= HORA_FIN)) {
    return { ok: true, motivo: "fuera de horario laboral", horaChile };
  }

  const accessToken = await getGoogleAccessToken(env, [
    "https://www.googleapis.com/auth/firebase.messaging",
    "https://www.googleapis.com/auth/firebase.database",
  ]);

  const [resViento, resUv] = await Promise.all([
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=wind_speed_10m,wind_gusts_10m&wind_speed_unit=kmh&timezone=America/Santiago&forecast_days=1`),
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=uv_index&timezone=America/Santiago&forecast_days=1`),
  ]);
  if (!resViento.ok || !resUv.ok) {
    return { ok: false, error: "No se pudo consultar Open-Meteo" };
  }
  const jViento = await resViento.json();
  const jUv = await resUv.json();

  const velocidad = Math.round(jViento.current.wind_speed_10m);
  const rafaga = Math.round(jViento.current.wind_gusts_10m);
  const kmhMax = Math.max(velocidad, rafaga);
  const uv = Math.round(jUv.current.uv_index * 10) / 10;
  const nivelViento = kmhMax >= 82 ? 3 : kmhMax >= 60 ? 2 : kmhMax >= 40 ? 1 : 0;

  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date()); // YYYY-MM-DD hora Chile
  const horaTexto = new Intl.DateTimeFormat("es-CL", { hour: "2-digit", minute: "2-digit", timeZone: "America/Santiago" }).format(new Date());

  // Guardar clima actual — lo lee el banner de la app
  await fbPut(accessToken, `${ROOT}/clima_actual`, {
    velocidad, rafaga, uv, nivelViento, hora: horaTexto, actualizado: Date.now(),
  });

  const yaEnviado = (await fbGet(accessToken, `${ROOT}/clima_alerta_enviada/${hoy}`)) || {};
  const alertasNuevas = {};
  const enviados = [];

  // ── Viento — desde Nivel 2 (60+ km/h velocidad o ráfaga) ──
  if (nivelViento >= 2 && (!yaEnviado.vientoNivel || yaEnviado.vientoNivel < nivelViento)) {
    const esNivel3 = nivelViento >= 3;
    const label = esNivel3 ? "Alerta ALTA" : "Alerta media";
    const acciones = esNivel3
      ? ["EVACUACIÓN INMEDIATA de zonas verdes", "Cerrar acceso a zonas deportivas", "Activar protocolo de emergencia"]
      : ["Suspender labores de jardinería en exterior", "Retirar herramientas y equipos livianos", "Encintar zonas de riesgo por caída de ramas"];
    const titulo = `🌬️ ${label} de viento — ${kmhMax} km/h`;
    const cuerpo = `Viento ${kmhMax} km/h (vel./ráfaga) — ${label}. ${acciones.join(" · ")}.`;
    await enviarAlerta(accessToken, titulo, cuerpo, esNivel3 ? "alta" : "media");
    alertasNuevas.vientoNivel = nivelViento;
    enviados.push(titulo);
  }

  // ── UV — desde 6 (Alto), mismos tramos de la tabla de Protocolo de Protección ──
  if (uv >= 6 && !yaEnviado.uv) {
    const NIVEL_MODERADO = "Lentes de sol, sombrero ala ancha, protector solar FPS 30+";
    let categoria, medidas;
    if (uv >= 11) {
      categoria = "Extremo";
      medidas = `${NIVEL_MODERADO}, manga larga obligatoria. Evitar exposición 10:00–16:00h, cuello protegido, hidratación constante.`;
    } else if (uv >= 8) {
      categoria = "Muy alto";
      medidas = `${NIVEL_MODERADO}, buscar sombra entre 11:00–15:00h. Manga larga obligatoria, reducir exposición 11:00–15:00h.`;
    } else {
      categoria = "Alto";
      medidas = `${NIVEL_MODERADO}. Buscar sombra entre 11:00–15:00h, manga larga recomendada.`;
    }
    const titulo = `☀️ Radiación UV ${categoria} — índice ${uv}`;
    const cuerpo = `Índice UV ${uv} — ${categoria}. ${medidas}`;
    await enviarAlerta(accessToken, titulo, cuerpo, "media");
    alertasNuevas.uv = true;
    enviados.push(titulo);
  }

  if (Object.keys(alertasNuevas).length > 0) {
    await fbPatch(accessToken, `${ROOT}/clima_alerta_enviada/${hoy}`, alertasNuevas);
  }

  return { ok: true, horaChile, velocidad, rafaga, uv, nivelViento, enviados };
}

async function enviarAlerta(accessToken, titulo, cuerpo, prioridad) {
  // 1) Notificación visible en el feed compartido (mismo formato que crearNotificacion en la app)
  const nueva = {
    id: Date.now() + Math.random(),
    tipo: "alerta_clima",
    fecha: new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date()),
    hora: new Intl.DateTimeFormat("es-CL", { hour: "2-digit", minute: "2-digit", timeZone: "America/Santiago" }).format(new Date()),
    leida: false,
    titulo,
    mensaje: cuerpo,
    prioridad,
  };
  const actuales = (await fbGet(accessToken, `${ROOT}/notificaciones`)) || [];
  const arr = Array.isArray(actuales) ? actuales : Object.values(actuales);
  await fbPut(accessToken, `${ROOT}/notificaciones`, [nueva, ...arr].slice(0, 100));

  // 2) Push a todos los tokens registrados (pushTokens vive en la raíz de la base, fuera de estadio-verde-data)
  const tokensObj = (await fbGet(accessToken, "pushTokens")) || {};
  const tokens = Object.values(tokensObj).map((t) => (typeof t === "string" ? t : t.token)).filter(Boolean);

  await Promise.all(
    tokens.map((token) =>
      fetch(`https://fcm.googleapis.com/v1/projects/riego-estadio-espanol/messages:send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: titulo, body: cuerpo },
            data: { tipo: "alerta_clima" },
          },
        }),
      }).catch(() => {})
    )
  );
}

// ── Helpers de acceso a Firebase Realtime Database vía REST (con token OAuth) ──
async function fbGet(accessToken, path) {
  const res = await fetch(`${DB_URL}/${path}.json`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}
async function fbPut(accessToken, path, data) {
  return fetch(`${DB_URL}/${path}.json`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
async function fbPatch(accessToken, path, data) {
  return fetch(`${DB_URL}/${path}.json`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// ── Helper: obtener un token OAuth2 de Google a partir de la cuenta de servicio ──
// (firma un JWT con la llave privada y lo intercambia por un access_token)
async function getGoogleAccessToken(env, scopes) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: env.FCM_CLIENT_EMAIL,
    scope: scopes.join(" "),
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const b64url = (bytes) =>
    btoa(String.fromCharCode(...new Uint8Array(bytes)))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
  const unsigned = `${enc(header)}.${enc(claim)}`;

  const key = await importPrivateKey(env.FCM_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${b64url(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const json = await res.json();
  if (!json.access_token) throw new Error("No se pudo obtener access_token: " + JSON.stringify(json));
  return json.access_token;
}

async function importPrivateKey(pem) {
  const pemContents = pem
    .replace(/\\n/g, "\n") // por si se pegó con \n literales (texto) en vez de saltos de línea reales
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    binaryDer.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}
