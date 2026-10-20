// js/estado-cliente.js
// ============================================================
// Puente estado.json ↔ sistema de alertas (v8)
// ------------------------------------------------------------
// v8:
//   - Solo arranca si APP_CONFIG.usarEstadoJSON === true
//     (keraunos.html sí, index.html no).
//   - Filtra alertas por origen: solo procesa las del scraper
//     (origen !== "manual").
//   - Modo "admin" ya NO se usa (admin no reenvía scraper).
// ============================================================

import { mostrarAlertaCompleta, mostrarAlertaLibre, quitarAlerta, marcarArranqueListo } from "./alertas.js";

const ESTADO_URL    = "./estado.json";
const INTERVALO_MS  = 30_000;
const STORAGE_KEY   = "keraunos_estado_cliente_v2";
const MAX_HISTORIAL = 200;

const cliente = {
    modo: null,
    intervaloId: null,
    historial: {},
    zonasVistas: new Set(),
    cargado: false
};

let primeraCarga = true;

function obtenerConfig() {
    return window.__APP_CONFIG__ || {
        usarEstadoJSON: true,
        origenFiltro: "scraper"
    };
}

function cargarHistorial() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { historial: {}, zonas: [] };
        const parsed = JSON.parse(raw);
        return {
            historial: parsed.historial || {},
            zonas: parsed.zonas || []
        };
    } catch { return { historial: {}, zonas: [] }; }
}

function guardarHistorial(historial, zonas) {
    try {
        const claves = Object.keys(historial);
        if (claves.length > MAX_HISTORIAL) {
            const recortadas = claves.slice(-MAX_HISTORIAL);
            const nuevo = {};
            recortadas.forEach(k => nuevo[k] = historial[k]);
            historial = nuevo;
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            historial,
            zonas: Array.from(zonas)
        }));
    } catch {}
}

function claveAlerta(a) {
    return `${a.distrito}::${a.timestampInicio}`;
}

async function leerEstado() {
    const url = `${ESTADO_URL}?t=${Date.now()}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
}

async function enviarAlertaFirestore(alerta) {
    const { enviarMensajePush } = await import("./mensajes.js");
    await enviarMensajePush(
        alerta.titulo || `⚡ ALERTA ${alerta.nivel.toUpperCase()} — ${alerta.distrito}`,
        alerta.mensaje || `Actividad eléctrica detectada en ${alerta.distrito}.`,
        {
            tipo: "alerta",
            nivel: alerta.nivel,
            distrito: alerta.distrito,
            lat: alerta.lat,
            lng: alerta.lng,
            duracionMin: alerta.duracionMin,
            timestampInicio: alerta.timestampInicio,
            sectorOriginal: alerta.sectorOriginal,
            inicio: alerta.inicio,
            fin: alerta.fin
        }
    );
}

async function ciclo() {
    let data;
    try {
        data = await leerEstado();
    } catch (e) {
        console.warn("estado-cliente: no se pudo leer estado.json:", e.message);
        if (primeraCarga) {
            primeraCarga = false;
            marcarArranqueListo("estado-cliente");
        }
        return;
    }

    const alertas = Array.isArray(data.alertas) ? data.alertas : [];
    const { historial, zonas } = cargarHistorial();
    const zonasVistas = new Set(zonas);
    const distritosActuales = new Set();

    // FASE 1 — Procesar alertas del scraper
    for (const a of alertas) {
        if (a.nivel !== "amarilla" && a.nivel !== "naranja" && a.nivel !== "roja") continue;
        if (!a.distrito) continue;

        // Filtro: en estado.json solo vienen del scraper.
        // Si por error trae origen === "manual", se ignora.
        const origenAlerta = a.origen || "keraunos";
        if (origenAlerta === "manual") continue;

        distritosActuales.add(a.distrito);

        const clave = claveAlerta(a);
        const anterior = historial[clave];
        const cambioNivel = anterior && anterior.nivel !== a.nivel;
        const cambioTimestamp = anterior && anterior.timestampInicio !== a.timestampInicio;
        const cambioDuracion = anterior && anterior.duracionMin !== a.duracionMin;
        const esNueva = primeraCarga || !anterior || cambioNivel || cambioTimestamp || cambioDuracion;

        if (esNueva) {
            historial[clave] = {
                nivel: a.nivel,
                timestampInicio: a.timestampInicio,
                duracionMin: a.duracionMin,
                distrito: a.distrito
            };
            zonasVistas.add(a.distrito);

            // En keraunos.html solo mostramos directo (no Firestore)
            try {
                await mostrarAlertaCompleta({
                    tipo:            "alerta",
                    nivel:           a.nivel,
                    titulo:          a.titulo,
                    mensaje:         a.mensaje,
                    distrito:        a.distrito,
                    lat:             a.lat,
                    lng:             a.lng,
                    duracionMin:     a.duracionMin,
                    timestampInicio: a.timestampInicio,
                    sectorOriginal:  a.sectorOriginal,
                    inicio:          a.inicio,
                    fin:             a.fin,
                    origen:          "scraper"
                });
            } catch (e) {
                console.error("estado-cliente: error mostrando alerta:", e);
            }
        }
    }

    // FASE 2 — Alertas resueltas
    const distritosResueltos = [];
    for (const d of zonasVistas) {
        if (!distritosActuales.has(d)) distritosResueltos.push(d);
    }

    for (const distrito of distritosResueltos) {
        zonasVistas.delete(distrito);
        try { await quitarAlerta(distrito); }
        catch (e) { console.error("estado-cliente: error quitando:", e); }
    }

    // FASE 3 — Si no hay zonas activas, mostrar libre
    if (distritosActuales.size === 0 && zonasVistas.size === 0 && !cliente.cargado) {
        try { await mostrarAlertaLibre(); } catch {}
        cliente.cargado = true;
    }

    if (primeraCarga) {
        primeraCarga = false;
        marcarArranqueListo("estado-cliente");
    }

    guardarHistorial(historial, zonasVistas);
}

export function iniciarEstadoCliente(opciones = {}) {
    if (cliente.intervaloId !== null) return;

    const cfg = obtenerConfig();

    // Solo arrancar si la página lo pide (keraunos.html)
    if (!cfg.usarEstadoJSON) {
        console.log("[estado-cliente] desactivado en esta página (usarEstadoJSON=false)");
        marcarArranqueListo("estado-cliente");  // liberar barrera
        return;
    }

    cliente.modo = opciones.modo || "index";
    console.log(`estado-cliente: iniciado en modo "${cliente.modo}" (${INTERVALO_MS / 1000}s)`);

    primeraCarga = true;
    ciclo();
    cliente.intervaloId = setInterval(ciclo, INTERVALO_MS);
}

export function detenerEstadoCliente() {
    if (cliente.intervaloId !== null) {
        clearInterval(cliente.intervaloId);
        cliente.intervaloId = null;
    }
}

export function resetearHistorial() {
    try {
        localStorage.removeItem(STORAGE_KEY);
        cliente.historial = {};
        cliente.zonasVistas = new Set();
        cliente.cargado = false;
        primeraCarga = true;
        console.log("estado-cliente: historial reseteado");
    } catch {}
}
