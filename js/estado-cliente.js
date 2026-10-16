// js/estado-cliente.js
// ============================================================
// Puente estado.json ↔ sistema de alertas (v6)
// v6: pasa `origen` a mostrarAlertaCompleta (viene null del
//     scraper, por eso NO degrada).
// v5: flag global para evitar parpadeo verde antes de alerta.
// ============================================================

import { mostrarAlertaCompleta, mostrarAlertaLibre, quitarAlerta } from "./alertas.js";

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

function cargarHistorial() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { historial: {}, zonas: [] };
        const parsed = JSON.parse(raw);
        return { historial: parsed.historial || {}, zonas: parsed.zonas || [] };
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

function claveAlerta(a) { return `${a.distrito}::${a.timestampInicio}`; }

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
            // Sin `origen` → será tratado como no-degradable por defecto.
        }
    );
}

async function enviarResolucionFirestore(distrito) {
    const { enviarMensajePush } = await import("./mensajes.js");
    await enviarMensajePush(
        `✅ Alerta finalizada — ${distrito}`,
        `La alerta meteorológica en ${distrito} ha finalizado.`,
        { tipo: "alerta-resuelta", distrito }
    );
}

async function ciclo() {
    let data;
    try {
        data = await leerEstado();
    } catch (e) {
        console.warn("estado-cliente: no se pudo leer estado.json:", e.message);
        if (primeraCarga && cliente.modo === "index") {
            window.__estadoClienteIniciando = false;
            primeraCarga = false;
        }
        return;
    }

    const alertas = Array.isArray(data.alertas) ? data.alertas : [];
    const { historial, zonas } = cargarHistorial();
    const zonasVistas = new Set(zonas);
    const distritosActuales = new Set();

    for (const a of alertas) {
        if (a.nivel !== "amarilla" && a.nivel !== "naranja" && a.nivel !== "roja") continue;
        if (!a.distrito) continue;
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

            if (cliente.modo === "admin") {
                try {
                    await enviarAlertaFirestore(a);
                    try {
                        const { mostrarToast } = await import("./notifications.js");
                        mostrarToast("🤖 Alerta automática enviada",
                            `${a.distrito} · ${a.nivel.toUpperCase()}`, "exito", false);
                    } catch {}
                } catch (e) { console.error("estado-cliente: error Firestore:", e); }
            } else if (cliente.modo === "index") {
                try {
                    await mostrarAlertaCompleta({
                        tipo: "alerta",
                        nivel: a.nivel,
                        titulo: a.titulo,
                        mensaje: a.mensaje,
                        distrito: a.distrito,
                        lat: a.lat,
                        lng: a.lng,
                        duracionMin: a.duracionMin,
                        timestampInicio: a.timestampInicio,
                        sectorOriginal: a.sectorOriginal,
                        inicio: a.inicio,
                        fin: a.fin,
                        origen: a.origen || null
                    });
                } catch (e) { console.error("estado-cliente: error mostrando alerta:", e); }
            }
        }
    }

    const distritosResueltos = [];
    for (const d of zonasVistas) {
        if (!distritosActuales.has(d)) distritosResueltos.push(d);
    }

    for (const distrito of distritosResueltos) {
        zonasVistas.delete(distrito);
        if (cliente.modo === "admin") {
            try {
                await enviarResolucionFirestore(distrito);
                try {
                    const { mostrarToast } = await import("./notifications.js");
                    mostrarToast("✅ Alerta finalizada", distrito, "info", false);
                } catch {}
            } catch (e) { console.error("estado-cliente: error resolución:", e); }
        } else if (cliente.modo === "index") {
            try { await quitarAlerta(distrito); }
            catch (e) { console.error("estado-cliente: error quitando:", e); }
        }
    }

    if (cliente.modo === "index" &&
        distritosActuales.size === 0 &&
        zonasVistas.size === 0 &&
        !cliente.cargado) {
        try { await mostrarAlertaLibre(); } catch {}
        cliente.cargado = true;
    }

    if (primeraCarga) {
        primeraCarga = false;
        if (cliente.modo === "index") {
            window.__estadoClienteIniciando = false;
        }
    }

    guardarHistorial(historial, zonasVistas);
}

export function iniciarEstadoCliente(opciones = {}) {
    if (cliente.intervaloId !== null) return;

    cliente.modo = opciones.modo || "index";
    console.log(`estado-cliente: iniciado en modo "${cliente.modo}" (${INTERVALO_MS / 1000}s)`);

    primeraCarga = true;
    if (cliente.modo === "index") {
        window.__estadoClienteIniciando = true;
    }

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
