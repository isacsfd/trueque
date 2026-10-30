"use strict";

const $ = (id) => document.getElementById(id);

const REQUEST_STATUS = {
  pending: "Pendiente",
  under_review: "En revisión",
  approved: "Aprobada",
  rejected: "Rechazada",
  scheduled: "Programada",
  in_process: "En curso",
  cancellation_pending: "Cancelación pendiente",
  completed: "Completada",
  cancelled: "Cancelada",
};
const EXCHANGE_STATUS = {
  planned: "Programado",
  in_process: "En curso",
  cancellation_pending: "Cancelación pendiente",
  completed: "Completado",
  cancelled: "Cancelado",
};
const RECEPTION_STATUS = {
  awaiting_delivery: "Esperando entrega",
  received: "Recibido",
  in_custody: "En custodia",
  evaluated: "Evaluado",
  accepted: "Aceptado",
  rejected: "Rechazado",
  return_pending: "Devolución pendiente",
  returned: "Devuelto",
  cancelled: "Cancelado",
};
const ADMISSION_STATUS = {
  pending: "Pendiente",
  authorized: "Autorizada",
  admitted: "Admitido",
  enabled: "Habilitado",
  reversed: "Revertido",
  rejected: "Rechazado",
};
const CONDITION_LABEL = {
  excellent: "Excelente",
  good: "Bueno",
  fair: "Aceptable",
  poor: "Deficiente",
  unassessed: "Sin evaluar",
};
const AVAILABILITY_LABEL = {
  available: "Disponible",
  unavailable: "No disponible",
  reserved: "Reservado",
  retired: "Retirado",
  exchange_out: "Entregado en intercambio",
};
const RESERVATION_STATUS = {
  active: "Reservado temporalmente",
  converted: "Asignado / comprometido",
  expired: "Reserva vencida",
  released: "Reserva liberada",
};

const state = {
  session: null,
  requests: [],
  capabilities: {},
  requestFilter: "all",
  requestBusy: false,
  requestSeq: 0,
  decision: null,
  decisionBusy: false,
  users: [],
  roles: [],
  batches: [],
  import: {
    file: null,
    inspection: null,
    sheetName: "",
    headerRow: 1,
    mapping: {},
    summary: null,
    detail: null,
    blocked: false,
    busy: false,
    idempotencyKey: null,
    confirmBusy: false,
  },
  toastTimer: null,
  successTimer: null,
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmt(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("es-CO");
}

function elapsedLabel(value) {
  if (!value) return "—";
  const start = new Date(value).getTime();
  if (Number.isNaN(start)) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - start) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (hours < 24) return `${hours} h ${remaining} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

function valueOr(value, fallback = "No registrado") {
  return value === null || value === undefined || String(value).trim() === "" ? fallback : String(value);
}

function statusLabel(map, value) {
  return map[value] || value || "—";
}

function newKey() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  const isForm = typeof FormData !== "undefined" && options.body instanceof FormData;
  if (options.body && !isForm) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers["X-IUB-Admin"] = "1";
  const response = await fetch(path, { credentials: "same-origin", ...options, method, headers });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("json")
    ? await response.json().catch(() => ({}))
    : await response.text().catch(() => "");
  if (!response.ok) {
    const message = typeof body === "object" && body && body.error
      ? body.error.message
      : (typeof body === "string" && body.trim() ? body : "No se pudo completar la operación.");
    const error = new Error(message || "No se pudo completar la operación.");
    error.status = response.status;
    error.code = typeof body === "object" && body && body.error ? body.error.code : undefined;
    throw error;
  }
  return body;
}

function errorText(error) {
  if (error && error.status === 401) return "Tu sesión expiró. Inicia sesión nuevamente.";
  if (error && error.status === 403) return "No tienes permiso para realizar esta operación.";
  if (error && error.status === 413) return "El archivo supera el tamaño máximo permitido (10 MB).";
  if (error && error.status === 429) return "Demasiados intentos. Espera antes de volver a intentarlo.";
  if (error && error.status === 503) return "El servicio no está disponible en este momento. Inténtalo de nuevo.";
  if (error && error.message) return error.message;
  return "No se pudo completar la operación. Inténtalo de nuevo.";
}

function showError(id, message) {
  const element = $(id);
  if (!element) return;
  element.textContent = message || "";
  element.hidden = !message;
}

function showSuccess(id, message) {
  const element = $(id);
  if (!element) return;
  element.textContent = message || "";
  element.hidden = !message;
}

function toast(message, kind = "success") {
  const element = $("toast");
  if (!element) return;
  if (state.toastTimer) clearTimeout(state.toastTimer);
  element.textContent = message;
  element.className = `toast ${kind}`;
  element.hidden = false;
  state.toastTimer = setTimeout(() => {
    element.hidden = true;
  }, 7000);
}

function showTab(name) {
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.hidden = panel.id !== `tab-${name}`;
  });
  document.querySelectorAll(".tabs button[data-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === name);
  });
  if (name === "solicitudes") void loadRequests();
  if (name === "importar") void loadBatches();
  if (name === "usuarios") void loadUsers().catch((error) => showError("usersError", errorText(error)));
  if (name === "auditoria") void loadAudit().catch((error) => showError("auditError", errorText(error)));
}

async function boot() {
  try {
    const current = await api("/api/admin/session");
    await enterApp(current.username);
  } catch {
    state.session = null;
    $("loginView").hidden = false;
    $("appView").hidden = true;
  }
}

async function enterApp(username) {
  state.session = { username };
  $("loginView").hidden = true;
  $("appView").hidden = false;
  $("whoami").textContent = username;
  showTab("solicitudes");
}

async function login(event) {
  event.preventDefault();
  showError("loginError", "");
  const button = event.submitter;
  if (button) button.disabled = true;
  try {
    const result = await api("/api/admin/session", {
      method: "POST",
      body: JSON.stringify({ username: $("loginUser").value.trim(), password: $("loginPass").value }),
    });
    $("loginPass").value = "";
    await enterApp(result.username);
  } catch (error) {
    const message = error && error.status === 401
      ? "Usuario o contraseña incorrectos."
      : errorText(error);
    showError("loginError", message);
  } finally {
    if (button) button.disabled = false;
  }
}

async function logout() {
  try { await api("/api/admin/session", { method: "DELETE" }); } catch { /* ignore */ }
  state.session = null;
  state.requests = [];
  state.batches = [];
  $("appView").hidden = true;
  $("loginView").hidden = false;
}

async function loadRequests() {
  const seq = ++state.requestSeq;
  state.requestBusy = true;
  showError("requestsError", "");
  try {
    const data = await api("/api/admin/workbench");
    if (seq !== state.requestSeq) return;
    state.requests = Array.isArray(data.items) ? data.items : [];
    state.capabilities = data.capabilities || {};
    renderRequests();
    renderImportPermission();
  } catch (error) {
    if (seq !== state.requestSeq) return;
    if (error.status === 401) {
      state.session = null;
      $("appView").hidden = true;
      $("loginView").hidden = false;
      showError("loginError", errorText(error));
      return;
    }
    showError("requestsError", errorText(error));
    $("requestsList").innerHTML = '<div class="empty">No se pudieron cargar las solicitudes.</div>';
  } finally {
    if (seq === state.requestSeq) state.requestBusy = false;
  }
}

function requestActions(item) {
  if (!state.capabilities.can_review) return "";
  if (item.requestStatus === "pending") {
    return `<button type="button" data-request-id="${esc(item.requestId)}" data-request-action="review">Iniciar revisión</button>`;
  }
  if (item.requestStatus === "under_review") {
    return `
      <button type="button" data-request-id="${esc(item.requestId)}" data-request-action="approve">Aprobar solicitud</button>
      <button type="button" class="danger" data-request-id="${esc(item.requestId)}" data-request-action="reject">Rechazar solicitud</button>`;
  }
  return "";
}

function detailRow(label, value, fallback = "No registrado") {
  return `<dt>${esc(label)}</dt><dd>${esc(valueOr(value, fallback))}</dd>`;
}

function renderRequests() {
  const filter = state.requestFilter;
  const visible = filter === "all"
    ? state.requests
    : state.requests.filter((item) => item.requestStatus === filter);
  $("requestCount").textContent = `${visible.length} solicitud(es) en este filtro · ${state.requests.length} en total`;
  if (visible.length === 0) {
    $("requestsList").innerHTML = '<div class="empty">No hay solicitudes en este filtro.</div>';
    return;
  }

  $("requestsList").innerHTML = visible.map((item) => {
    const student = item.student || {};
    const offered = item.offeredBook || {};
    const requested = item.requestedBook || {};
    const reservation = item.reservation || {};
    const missing = (item.dataStatus && item.dataStatus.missing) || [];
    const studentName = student.fullName
      || (student.restricted ? "No disponible por permisos" : "No registrado");
    const requestedTitle = requested.title || "Libro solicitado no registrado en esta solicitud";
    const offeredTitle = offered.title || "Libro ofrecido no registrado";
    const legacyBadge = item.dataStatus && item.dataStatus.legacyIncomplete
      ? '<span class="chip warn">Solicitud antigua incompleta</span>'
      : "";
    const missingRequested = !requested.title
      ? '<div class="notice warning tiny" style="margin:8px 0 0">Libro solicitado no registrado en esta solicitud. No se dedujo ni se inventó a partir del libro ofrecido.</div>'
      : "";
    const missingStudent = !student.fullName && !student.restricted
      ? '<div class="notice warning tiny" style="margin:8px 0 0">Datos del estudiante no registrados en esta solicitud.</div>'
      : "";
    const history = Array.isArray(item.history) ? item.history : [];
    const actions = requestActions(item);
    const reviewNote = !state.capabilities.can_review
      ? '<p class="muted tiny" style="margin:10px 0 0">Tu perfil puede consultar las solicitudes, pero no aprobarlas ni rechazarlas.</p>'
      : "";

    return `
      <article class="request-card" data-request-card="${esc(item.requestId)}">
        <div class="request-head">
          <div>
            <span class="request-code">Solicitud ${esc(item.requestCode)}</span>
            <h3 class="request-title"><small>Libro que solicita</small>${esc(requestedTitle)}</h3>
            <p class="muted" style="margin:0">${esc(requested.author || "Autor no registrado")}${requested.inventoryCode ? ` · Ejemplar ${esc(requested.inventoryCode)}` : ""}</p>
          </div>
          <div class="request-meta">
            <span class="status status-${esc(item.requestStatus)}">${esc(statusLabel(REQUEST_STATUS, item.requestStatus))}</span>
            ${item.exchangeStatus ? `<span class="status">${esc(statusLabel(EXCHANGE_STATUS, item.exchangeStatus))}</span>` : ""}
            ${legacyBadge}
          </div>
        </div>

        <div class="request-summary">
          <div class="summary-box">
            <span class="k">Estudiante</span>
            <strong>${esc(studentName)}</strong>
            <div class="sub">${esc(student.email || (student.restricted ? "Correo no disponible por permisos" : "Correo no registrado"))}</div>
          </div>
          <div class="summary-box">
            <span class="k">Libro ofrecido</span>
            <strong>${esc(offeredTitle)}</strong>
            <div class="sub">${esc(offered.author || "Autor no registrado")}${offered.condition ? ` · ${esc(statusLabel(CONDITION_LABEL, offered.condition))}` : ""}</div>
          </div>
          <div class="summary-box">
            <span class="k">Fecha de solicitud</span>
            <strong>${esc(fmt(item.createdAt))}</strong>
            <div class="sub">${esc(item.requestedInventoryCode ? `Ejemplar solicitado ${item.requestedInventoryCode}` : "Sin código de ejemplar")}</div>
          </div>
          <div class="summary-box">
            <span class="k">Reserva del ejemplar</span>
            <strong>${esc(reservation.status ? statusLabel(RESERVATION_STATUS, reservation.status) : "Sin reserva registrada")}</strong>
            <div class="sub">${reservation.createdAt ? `Desde ${esc(fmt(reservation.createdAt))} · ${esc(elapsedLabel(reservation.createdAt))}` : "Sin fecha de reserva"}</div>
          </div>
        </div>

        <details class="request-detail">
          <summary>Ver detalle completo de la solicitud</summary>
          ${missingRequested}${missingStudent}
          <div class="detail-grid">
            <section aria-label="Datos del estudiante">
              <h4>Datos del estudiante</h4>
              <dl class="kv">
                ${detailRow("Nombre completo", student.fullName, student.restricted ? "No disponible por permisos" : "No registrado")}
                ${detailRow("Correo", student.email, student.restricted ? "No disponible por permisos" : "No registrado")}
                ${detailRow("Código o identificación institucional", student.institutionalCode)}
                ${detailRow("Programa académico", student.academicProgram)}
                ${detailRow("Fecha de solicitud", fmt(item.createdAt), "No registrada")}
                ${detailRow("Estado actual", statusLabel(REQUEST_STATUS, item.requestStatus))}
              </dl>
            </section>

            <section aria-label="Libro ofrecido">
              <h4>Libro ofrecido</h4>
              <dl class="kv">
                ${detailRow("Título", offered.title)}
                ${detailRow("Autor", offered.author)}
                ${detailRow("ISBN", offered.isbn)}
                ${detailRow("Editorial", offered.publisher)}
                ${detailRow("Género declarado", offered.genre)}
                ${detailRow("Condición declarada", statusLabel(CONDITION_LABEL, offered.condition))}
                ${detailRow("Observaciones", offered.observations)}
                ${detailRow("Evaluación", item.evaluationOutcome ? statusLabel({ accepted: "Aceptado", rejected: "Rechazado" }, item.evaluationOutcome) : "Sin evaluación")}
                ${detailRow("Catalogación", item.catalogingStatus || "Sin catalogación")}
                ${detailRow("Admisión", item.admissionStatus ? statusLabel(ADMISSION_STATUS, item.admissionStatus) : "Sin admisión")}
              </dl>
            </section>

            <section aria-label="Libro solicitado" style="grid-column:1/-1;border-color:#c9d8ee;background:#f5f9ff">
              <h4>Libro que quiere recibir el estudiante</h4>
              <dl class="kv">
                ${detailRow("Título", requested.title)}
                ${detailRow("Autor", requested.author)}
                ${detailRow("ISBN", requested.isbn)}
                ${detailRow("Editorial", requested.publisher)}
                ${detailRow("Género", requested.genre)}
                ${detailRow("Edición / año", [requested.edition, requested.publicationYear].filter(Boolean).join(" · ") || null)}
                ${detailRow("Código del ejemplar", requested.inventoryCode)}
                ${detailRow("Disponibilidad", requested.availability ? statusLabel(AVAILABILITY_LABEL, requested.availability) : null)}
                ${detailRow("Condición física", requested.physicalCondition ? statusLabel(CONDITION_LABEL, requested.physicalCondition) : null)}
                ${detailRow("Ubicación", requested.location)}
                ${detailRow("Fecha de selección", fmt(requested.selectedAt || item.createdAt), "No registrada")}
                ${detailRow("Reserva", reservation.status ? statusLabel(RESERVATION_STATUS, reservation.status) : "Sin reserva registrada")}
                ${detailRow("Reservado desde", fmt(reservation.createdAt), "No registrado")}
                ${detailRow("Vence", fmt(reservation.expiresAt), "No registrado")}
                ${detailRow("Tiempo transcurrido", elapsedLabel(reservation.createdAt), "No registrado")}
              </dl>
            </section>

            <section aria-label="Historial de decisiones" style="grid-column:1/-1">
              <h4>Historial de decisiones</h4>
              ${history.length === 0 ? '<p class="muted tiny">Sin movimientos registrados.</p>' : `
                <ol class="history-list">
                  ${history.map((entry) => `
                    <li>
                      <strong>${esc(statusLabel(REQUEST_STATUS, entry.newStatus))}</strong>
                      <span class="muted"> · ${esc(fmt(entry.changedAt))}${entry.changedBy ? ` · ${esc(entry.changedBy)}` : ""}</span>
                      ${entry.reason ? `<div class="muted">Motivo: ${esc(entry.reason)}</div>` : ""}
                    </li>`).join("")}
                </ol>`}
            </section>
          </div>
        </details>

        ${reviewNote}
        ${actions ? `<div class="action-bar">${actions}</div>` : ""}
      </article>`;
  }).join("");
}

function findRequest(requestId) {
  return state.requests.find((item) => item.requestId === requestId);
}

function openDecision(item, action) {
  state.decision = { item, action };
  state.decisionBusy = false;
  const dialog = $("decisionDialog");
  const reasonWrap = $("decisionReasonWrap");
  const reason = $("decisionReason");
  const title = $("decisionTitle");
  const body = $("decisionBody");
  const submit = $("decisionSubmit");
  const label = $("decisionReasonLabel");
  const help = $("decisionReasonHelp");
  showError("decisionError", "");
  showError("decisionReasonError", "");
  reason.value = "";
  reasonWrap.hidden = action === "review";
  submit.className = action === "reject" ? "danger" : "";
  submit.disabled = false;
  $("decisionCancel").disabled = false;

  if (action === "review") {
    title.textContent = "Iniciar revisión";
    body.textContent = `La solicitud ${item.requestCode} pasará a En revisión. No se aprueba ni se rechaza.`;
    submit.textContent = "Iniciar revisión";
  } else if (action === "approve") {
    title.textContent = "Aprobar solicitud";
    body.textContent = `Vas a aprobar la solicitud ${item.requestCode}. La aprobación no entrega el libro ni completa el intercambio.`;
    label.textContent = "Nota de aprobación (opcional)";
    help.textContent = "Puedes dejarla vacía. No se exige un motivo de rechazo para aprobar.";
    submit.textContent = "Aprobar solicitud";
  } else {
    title.textContent = "Rechazar solicitud";
    body.textContent = `Vas a rechazar la solicitud ${item.requestCode}. El motivo quedará registrado en el historial y será visible para el equipo.`;
    label.textContent = "Motivo del rechazo";
    help.textContent = "Obligatorio. Mínimo 3 caracteres.";
    submit.textContent = "Rechazar solicitud";
  }
  dialog.showModal();
  if (action !== "review") setTimeout(() => reason.focus(), 30);
}

async function submitDecision() {
  if (!state.decision || state.decisionBusy) return;
  const { item, action } = state.decision;
  const reason = $("decisionReason").value.trim();
  showError("decisionError", "");
  showError("decisionReasonError", "");
  if (action === "reject" && reason.length < 3) {
    showError("decisionReasonError", "Escribe el motivo del rechazo (mínimo 3 caracteres).");
    $("decisionReason").focus();
    return;
  }
  if (reason.length > 3000) {
    showError("decisionReasonError", "El motivo no puede superar 3000 caracteres.");
    return;
  }

  state.decisionBusy = true;
  const submit = $("decisionSubmit");
  const cancel = $("decisionCancel");
  const original = submit.textContent;
  submit.disabled = true;
  cancel.disabled = true;
  submit.textContent = "Procesando…";
  try {
    const payload = {
      action: `request.${action}`,
      requestId: item.requestId,
    };
    if (reason) payload.reason = reason;
    await api("/api/admin/action", { method: "POST", body: JSON.stringify(payload) });
    $("decisionDialog").close();
    const success = action === "approve"
      ? `Solicitud ${item.requestCode} aprobada. No se marcó como intercambio completado.`
      : action === "reject"
        ? `Solicitud ${item.requestCode} rechazada. El motivo quedó registrado en el historial.`
        : `Solicitud ${item.requestCode} en revisión.`;
    showSuccess("requestsSuccess", success);
    if (state.successTimer) clearTimeout(state.successTimer);
    state.successTimer = setTimeout(() => showSuccess("requestsSuccess", ""), 10000);
    toast(success, "success");
    await loadRequests();
    // Neon HTTP reads can briefly lag the write; refresh once more without
    // hiding the operation result from the operator.
    setTimeout(() => void loadRequests(), 800);
  } catch (error) {
    if (error.status === 401) {
      $("decisionDialog").close();
      state.session = null;
      $("appView").hidden = true;
      $("loginView").hidden = false;
      showError("loginError", errorText(error));
      return;
    }
    if (error.status === 409) {
      showError("decisionError", `${errorText(error)} Actualiza la lista para ver el estado vigente.`);
      await loadRequests();
    } else {
      showError("decisionError", errorText(error));
    }
  } finally {
    state.decisionBusy = false;
    submit.disabled = false;
    cancel.disabled = false;
    submit.textContent = original;
  }
}

function renderImportPermission() {
  const canImport = state.capabilities.can_import === true;
  $("importPermission").hidden = canImport || state.capabilities.can_read_batches === true;
  $("importPermission").textContent = canImport
    ? ""
    : "Tu cuenta no tiene permiso para importar inventario. Puedes consultar el historial si tu perfil lo permite.";
  $("importForm").hidden = !canImport;
}

function setImportError(message) {
  showError("importError", message);
}

function setImportSuccess(message) {
  showSuccess("importSuccess", message);
}

function resetImport(clearFile = true) {
  state.import.inspection = null;
  state.import.sheetName = "";
  state.import.headerRow = 1;
  state.import.mapping = {};
  state.import.summary = null;
  state.import.detail = null;
  state.import.blocked = false;
  state.import.busy = false;
  state.import.idempotencyKey = null;
  state.import.confirmBusy = false;
  $("inspection").hidden = true;
  $("importSummary").hidden = true;
  $("previewBlock").innerHTML = "";
  $("summaryRows").innerHTML = "";
  $("summaryStats").innerHTML = "";
  $("observations").value = "";
  setImportError("");
  setImportSuccess("");
  if (clearFile) {
    state.import.file = null;
    $("fileInfo").hidden = true;
    $("fileInput").value = "";
  }
}

function fileError(file) {
  if (!file) return "Selecciona un archivo .xlsx.";
  if (!/\.xlsx$/i.test(file.name)) return "El archivo debe tener extensión .xlsx.";
  if (file.size <= 0) return "El archivo está vacío.";
  if (file.size > 10 * 1024 * 1024) return "El archivo supera el tamaño máximo de 10 MB.";
  return "";
}

async function chooseFile(file) {
  const message = fileError(file);
  if (message) {
    setImportError(message);
    return;
  }
  resetImport(true);
  state.import.file = file;
  state.import.idempotencyKey = newKey();
  $("fileInfo").textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB · SHA-256 se calcula en el servidor antes de guardar.`;
  $("fileInfo").hidden = false;
  await inspectFile();
}

function fillSelect(element, values, selected) {
  element.innerHTML = values.map((value) => `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(value)}</option>`).join("");
}

function normalizeHeader(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

const MAPPING_FIELDS = [
  { key: "title", label: "Título", required: true },
  { key: "author", label: "Autor", required: true },
  { key: "publisher", label: "Editorial" },
  { key: "genre", label: "Género" },
  { key: "isbn", label: "ISBN (opcional)" },
  { key: "inventory_code", label: "Código de inventario (opcional)" },
  { key: "location", label: "Ubicación" },
  { key: "observations", label: "Observaciones" },
  { key: "source_number", label: "Número fuente" },
  { key: "copy_number", label: "Número de ejemplar" },
];

const HEADER_SYNONYMS = {
  title: ["titulo", "nombre de libro", "nombre del libro", "libro", "title"],
  author: ["autor", "autora", "author"],
  publisher: ["editorial", "publisher"],
  genre: ["genero", "categoria", "tematica", "genre"],
  isbn: ["isbn"],
  inventory_code: ["codigo de inventario", "codigo inventario", "inventory code", "inventory_code"],
  location: ["biblioteca", "ubicacion", "sede", "location"],
  observations: ["observacion", "observaciones", "notas", "observations"],
  source_number: ["no.", "no", "numero", "item", "#"],
  copy_number: ["ejemplar", "copia", "copy"],
};

function suggestMapping(headers) {
  const mapping = {};
  const normalized = headers.map((header) => ({ header, key: normalizeHeader(header) }));
  for (const field of MAPPING_FIELDS) {
    const synonyms = HEADER_SYNONYMS[field.key] || [];
    const match = normalized.find((entry) => synonyms.includes(entry.key))
      || normalized.find((entry) => synonyms.some((synonym) => entry.key.startsWith(`${synonym} `) || entry.key.endsWith(` ${synonym}`)));
    if (match) mapping[field.key] = match.header;
  }
  return mapping;
}

function renderMapping() {
  const headers = state.import.inspection.selected.headers || [];
  $("mappingGrid").innerHTML = MAPPING_FIELDS.map((field) => `
    <label>${esc(field.label)}${field.required ? " *" : ""}
      <select data-mapping-key="${esc(field.key)}">
        <option value="">— No usar —</option>
        ${headers.map((header) => `<option value="${esc(header)}"${state.import.mapping[field.key] === header ? " selected" : ""}>${esc(header)}</option>`).join("")}
      </select>
    </label>`).join("");
}

function renderPreview() {
  const selected = state.import.inspection.selected;
  const headers = selected.headers || [];
  const rows = selected.sampleRows || [];
  if (headers.length === 0) {
    $("previewBlock").innerHTML = '<div class="notice warning">No se detectaron encabezados en la fila seleccionada. Cambia la fila de encabezados.</div>';
    return;
  }
  $("previewBlock").innerHTML = `
    <p class="muted tiny">Vista previa de las primeras ${rows.length} filas. Los datos todavía no se han guardado.</p>
    <table>
      <thead><tr><th>Fila</th>${headers.map((header) => `<th>${esc(header)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((row) => `<tr><td>${esc(row.rowNumber)}</td>${headers.map((_, index) => `<td>${esc(row.values[index] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody>
    </table>`;
}

async function inspectFile(sheetName, headerRow) {
  const file = state.import.file;
  if (!file) return;
  setImportError("");
  state.import.busy = true;
  $("prevalidateBtn").disabled = true;
  try {
    const form = new FormData();
    form.set("action", "inspect");
    form.set("file", file);
    if (sheetName) form.set("sheetName", sheetName);
    if (headerRow) form.set("headerRow", String(headerRow));
    const result = await api("/api/admin/batches", { method: "POST", body: form });
    state.import.inspection = result;
    state.import.sheetName = result.selected.name;
    state.import.headerRow = result.selected.headerRow;
    state.import.mapping = suggestMapping(result.selected.headers || []);
    fillSelect($("sheetSelect"), result.sheets || [], state.import.sheetName);
    $("headerRow").value = String(state.import.headerRow);
    renderMapping();
    renderPreview();
    $("inspection").hidden = false;
    $("importSummary").hidden = true;
    $("prevalidateBtn").disabled = false;
  } catch (error) {
    state.import.inspection = null;
    $("inspection").hidden = true;
    setImportError(errorText(error));
  } finally {
    state.import.busy = false;
  }
}

async function prevalidate() {
  const file = state.import.file;
  if (!file || !state.import.inspection || state.import.busy) return;
  const mapping = {};
  for (const field of MAPPING_FIELDS) {
    const value = state.import.mapping[field.key];
    if (value) mapping[field.key] = value;
  }
  for (const field of MAPPING_FIELDS.filter((item) => item.required)) {
    if (!mapping[field.key]) {
      setImportError(`Selecciona la columna para ${field.label}.`);
      return;
    }
  }
  setImportError("");
  setImportSuccess("");
  state.import.busy = true;
  $("prevalidateBtn").disabled = true;
  $("prevalidateBtn").textContent = "Validando…";
  try {
    const form = new FormData();
    form.set("action", "prevalidate");
    form.set("file", file);
    form.set("sheetName", state.import.sheetName);
    form.set("headerRow", String(state.import.headerRow));
    form.set("mapping", JSON.stringify(mapping));
    form.set("observations", $("observations").value.trim());
    form.set("idempotencyKey", state.import.idempotencyKey);
    const summary = await api("/api/admin/batches", { method: "POST", body: form });
    state.import.summary = summary;
    state.import.blocked = false;
    await loadBatchDetail(summary.batchId, true);
    renderSummary();
    $("importSummary").hidden = false;
    $("importSummary").scrollIntoView({ behavior: "smooth", block: "start" });
    setImportSuccess("Prevalidación guardada. Revisa el resumen antes de confirmar; el inventario todavía no se ha modificado.");
    await loadBatches();
    setTimeout(() => void loadBatches(), 800);
  } catch (error) {
    if (error.code === "already_imported") {
      state.import.blocked = true;
      state.import.summary = null;
      $("importSummary").hidden = true;
      setImportError(error.message);
    } else {
      setImportError(errorText(error));
    }
  } finally {
    state.import.busy = false;
    $("prevalidateBtn").disabled = false;
    $("prevalidateBtn").textContent = "Previsualizar y validar";
  }
}

function renderSummary() {
  const summary = state.import.summary;
  if (!summary) return;
  const detailRows = state.import.detail && Array.isArray(state.import.detail.rows) ? state.import.detail.rows : [];
  $("summaryStats").innerHTML = [
    ["Filas", summary.totalRows],
    ["Válidas", summary.validRows],
    ["Advertencias", summary.warningRows],
    ["Rechazadas", summary.rejectedRows],
    ["Duplicadas", summary.duplicateRows],
  ].map(([label, value]) => `<div><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`).join("");

  const notes = [];
  if (summary.validRows + summary.warningRows === 0) notes.push("No hay filas importables. Corrige el archivo o el mapeo.");
  if (summary.warningRows > 0) notes.push(`${summary.warningRows} fila(s) tienen advertencias de posible duplicado o ISBN repetido. Se conservarán como ejemplares separados si confirmas.`);
  if (summary.rejectedRows > 0) notes.push(`${summary.rejectedRows} fila(s) no se importarán por errores de validación.`);
  if (summary.duplicateRows > 0) notes.push(`${summary.duplicateRows} fila(s) tienen códigos de inventario repetidos dentro del lote y no se importarán.`);
  $("summaryNotice").textContent = notes.join(" ") || "El lote no presenta advertencias.";
  $("summaryNotice").className = `notice ${summary.warningRows || summary.rejectedRows || summary.duplicateRows ? "warning" : "success"}`;
  $("confirmImportBtn").disabled = summary.validRows + summary.warningRows === 0 || state.import.blocked;
  $("cancelImportBtn").disabled = state.import.blocked;

  if (detailRows.length === 0) {
    $("summaryRows").innerHTML = '<p class="muted">No hay detalle de filas disponible.</p>';
    return;
  }
  const shown = detailRows.slice(0, 250);
  $("summaryRows").innerHTML = `
    <p class="muted tiny">Detalle por fila (${shown.length} de ${detailRows.length}).</p>
    <table>
      <thead><tr><th>Fila</th><th>Estado</th><th>Título</th><th>Autor</th><th>ISBN</th><th>Código</th><th>Errores / advertencias</th></tr></thead>
      <tbody>${shown.map((row) => `
        <tr>
          <td>${esc(row.sourceRow)}</td>
          <td><span class="chip ${row.status === "rejected" || row.status === "duplicate" ? "bad" : row.status === "warning" ? "warn" : "ok"}">${esc(row.status)}</span></td>
          <td>${esc(row.mapped?.title || "")}</td>
          <td>${esc(row.mapped?.author || "")}</td>
          <td>${esc(row.mapped?.isbn || "")}</td>
          <td>${esc(row.inventoryCode || row.mapped?.inventory_code || "")}</td>
          <td class="muted">${esc([...(row.errors || []), ...(row.warnings || [])].join(" · ") || "—")}</td>
        </tr>`).join("")}</tbody>
    </table>`;
}

async function loadBatchDetail(batchId, keepSummary = false) {
  try {
    const detail = await api(`/api/admin/batches/detail?id=${encodeURIComponent(batchId)}`);
    state.import.detail = detail;
    renderBatchDetail(detail);
    if (keepSummary) renderSummary();
  } catch (error) {
    showError("importError", errorText(error));
  }
}

function renderBatchDetail(detail) {
  if (!detail || !detail.batch) {
    $("batchDetail").innerHTML = "";
    return;
  }
  const batch = detail.batch;
  const rows = Array.isArray(detail.rows) ? detail.rows : [];
  $("batchDetail").innerHTML = `
    <h3>Detalle del lote ${esc(batch.batchId)}</h3>
    <p class="muted">${esc(batch.fileName)} · ${esc(batch.sheetName)} · SHA-256 ${esc(batch.sha256)} · ${esc(batch.status)}</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Fila</th><th>Estado</th><th>Título</th><th>Autor</th><th>Código</th><th>Errores / advertencias</th></tr></thead>
        <tbody>${rows.map((row) => `<tr>
          <td>${esc(row.sourceRow)}</td>
          <td>${esc(row.status)}</td>
          <td>${esc(row.mapped?.title || "")}</td>
          <td>${esc(row.mapped?.author || "")}</td>
          <td>${esc(row.inventoryCode || row.mapped?.inventory_code || "")}</td>
          <td class="muted">${esc([...(row.errors || []), ...(row.warnings || [])].join(" · ") || "—")}</td>
        </tr>`).join("")}</tbody>
      </table>
    </div>`;
}

async function confirmImport() {
  const summary = state.import.summary;
  if (!summary || state.import.confirmBusy) return;
  if (!$("importConfirmCheck").checked) return;
  state.import.confirmBusy = true;
  $("importConfirmSubmit").disabled = true;
  $("importConfirmSubmit").textContent = "Importando…";
  $("importConfirmCancel").disabled = true;
  try {
    const result = await api("/api/admin/batches/confirm", {
      method: "POST",
      body: JSON.stringify({ batchId: summary.batchId, idempotencyKey: newKey() }),
    });
    $("importConfirmDialog").close();
    const message = `Lote confirmado: ${result.insertedRows + result.reusedRows} ejemplar(es) creado(s) (${result.reusedRows} con registro bibliográfico existente reutilizado), ${result.skippedRows} omitido(s). Los ejemplares quedaron no disponibles y pendientes de verificación.`;
    setImportSuccess(message);
    toast(message, "success");
    state.import.summary = null;
    state.import.detail = null;
    $("importSummary").hidden = true;
    $("observations").value = "";
    await loadBatches();
    setTimeout(() => void loadBatches(), 800);
    await loadBatchDetail(result.batchId, false);
  } catch (error) {
    setImportError(errorText(error));
    $("importConfirmDialog").close();
    await loadBatches();
  } finally {
    state.import.confirmBusy = false;
    $("importConfirmSubmit").disabled = false;
    $("importConfirmSubmit").textContent = "Importar";
    $("importConfirmCancel").disabled = false;
  }
}

async function cancelBatch(batchId) {
  if (!window.confirm("¿Cancelar esta prevalidación? No modifica el inventario.")) return;
  setImportError("");
  try {
    await api("/api/admin/batches/cancel", {
      method: "POST",
      body: JSON.stringify({ batchId, idempotencyKey: newKey() }),
    });
    setImportSuccess("Prevalidación cancelada. El inventario no se modificó.");
    state.import.summary = null;
    $("importSummary").hidden = true;
    await loadBatches();
    setTimeout(() => void loadBatches(), 800);
  } catch (error) {
    setImportError(errorText(error));
  }
}

async function downloadReport(batchId) {
  try {
    const response = await fetch(`/api/admin/batches/report?id=${encodeURIComponent(batchId)}`, {
      credentials: "same-origin",
      headers: { Accept: "text/csv" },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body?.error?.message || "No se pudo descargar el reporte.");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `lote-${batchId}-validacion.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (error) {
    setImportError(errorText(error));
  }
}

async function loadBatches() {
  showError("importError", "");
  try {
    const data = await api("/api/admin/batches/list");
    state.batches = Array.isArray(data.items) ? data.items : [];
    renderBatches();
  } catch (error) {
    if (error.status === 403) {
      $("batchHistory").innerHTML = '<div class="empty">Tu cuenta no tiene permiso para consultar el historial de importaciones.</div>';
      return;
    }
    $("batchHistory").innerHTML = '<div class="empty">No se pudo cargar el historial.</div>';
    showError("importError", errorText(error));
  }
}

function renderBatches() {
  if (state.batches.length === 0) {
    $("batchHistory").innerHTML = '<div class="empty">No hay importaciones registradas.</div>';
    return;
  }
  $("batchHistory").innerHTML = `
    <table>
      <thead><tr><th>Archivo</th><th>Estado</th><th>Filas</th><th>Válidas</th><th>Importadas</th><th>Responsable</th><th>Fecha</th><th>Acciones</th></tr></thead>
      <tbody>${state.batches.map((batch) => `
        <tr>
          <td><strong>${esc(batch.fileName)}</strong><br><span class="muted tiny">${esc(String(batch.sha256 || "").slice(0, 16))}…</span></td>
          <td><span class="status status-${esc(batch.status)}">${esc(batch.status)}</span></td>
          <td>${esc(batch.totalRows)}</td>
          <td>${esc(batch.validRows + batch.warningRows)}</td>
          <td>${esc(batch.insertedRows + batch.reusedRows)}</td>
          <td>${esc(batch.createdBy)}</td>
          <td>${esc(fmt(batch.createdAt))}</td>
          <td><div class="inline">
            <button type="button" class="secondary" data-batch-detail="${esc(batch.batchId)}">Detalle</button>
            <button type="button" class="secondary" data-batch-report="${esc(batch.batchId)}">CSV</button>
            ${batch.status === "prevalidated" ? `<button type="button" class="success" data-batch-confirm="${esc(batch.batchId)}">Confirmar</button><button type="button" class="secondary" data-batch-cancel="${esc(batch.batchId)}">Cancelar</button>` : ""}
          </div></td>
        </tr>`).join("")}</tbody>
    </table>`;
}

function askConfirmBatch(batchId) {
  const batch = state.batches.find((item) => String(item.batchId) === String(batchId));
  if (!batch) return;
  $("importConfirmSummary").textContent = `${batch.fileName}: ${batch.validRows + batch.warningRows} fila(s) importables, ${batch.rejectedRows} rechazadas, ${batch.duplicateRows} duplicadas. Los ejemplares quedarán no disponibles.`;
  $("importConfirmCheck").checked = false;
  $("importConfirmSubmit").disabled = true;
  state.import.summary = {
    batchId: batch.batchId,
    totalRows: batch.totalRows,
    validRows: batch.validRows,
    warningRows: batch.warningRows,
    rejectedRows: batch.rejectedRows,
    duplicateRows: batch.duplicateRows,
  };
  $("importConfirmDialog").showModal();
}

async function loadUsers() {
  showError("usersError", "");
  const data = await api("/api/admin/users");
  state.users = data.users || [];
  state.roles = data.roles || [];
  const roleOptions = state.roles.map((role) => `<option value="${esc(role.role_key)}">${esc(role.display_name)}</option>`).join("");
  $("newRole").innerHTML = roleOptions;
  $("usersTable").innerHTML = `<table><thead><tr><th>Cuenta</th><th>Correo</th><th>Perfil</th><th>Estado</th><th>Creada</th><th>Último acceso</th><th>Acciones</th></tr></thead><tbody>${state.users.map((user) => {
    const assigned = (user.roles || []).map((role) => role.roleKey);
    const available = state.roles.filter((role) => !assigned.includes(role.role_key));
    return `<tr><td><strong>${esc(user.login_name)}</strong>${user.must_change_password ? '<br><span class="chip warn">Cambio pendiente</span>' : ""}</td><td>${esc(user.email || "—")}</td><td>${(user.roles || []).map((role) => `<span class="chip">${esc(role.displayName)}${role.roleKey === "super_admin" ? "" : ` <button class="secondary" style="padding:1px 5px;font-size:.65rem" data-remove="${esc(user.user_id)}|${esc(role.roleKey)}">×</button>`}</span>`).join("") || "—"}</td><td>${user.is_active ? "Activa" : '<span class="muted">Inactiva</span>'}</td><td>${fmt(user.created_at)}</td><td>${fmt(user.last_login_at)}</td><td><div class="inline">${available.length ? `<select data-role-select="${esc(user.user_id)}"><option value="">Asignar perfil</option>${available.map((role) => `<option value="${esc(role.role_key)}">${esc(role.display_name)}</option>`).join("")}</select><button class="secondary" data-assign="${esc(user.user_id)}">Asignar</button>` : ""}<button class="secondary" data-toggle="${esc(user.user_id)}|${user.is_active ? "0" : "1"}">${user.is_active ? "Desactivar" : "Activar"}</button><button class="secondary" data-reset="${esc(user.user_id)}">Restablecer</button></div></td></tr>`;
  }).join("")}</tbody></table>`;
  $("usersTable").querySelectorAll("[data-assign]").forEach((button) => {
    button.onclick = () => assignRole(button.dataset.assign);
  });
  $("usersTable").querySelectorAll("[data-toggle]").forEach((button) => {
    button.onclick = () => toggleUser(button.dataset.toggle);
  });
  $("usersTable").querySelectorAll("[data-reset]").forEach((button) => {
    button.onclick = () => resetPassword(button.dataset.reset);
  });
  $("usersTable").querySelectorAll("[data-remove]").forEach((button) => {
    button.onclick = () => removeRole(button.dataset.remove);
  });
}

async function createUser(event) {
  event.preventDefault();
  showError("createError", "");
  const button = event.submitter;
  if (button) button.disabled = true;
  try {
    const result = await api("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({
        action: "create",
        email: $("newEmail").value.trim(),
        loginName: $("newLogin").value.trim(),
        roleKey: $("newRole").value,
      }),
    });
    $("createForm").reset();
    await loadUsers();
    showTemp(result.temporaryPassword);
  } catch (error) {
    showError("createError", errorText(error));
  } finally {
    if (button) button.disabled = false;
  }
}

async function toggleUser(value) {
  const [id, active] = value.split("|");
  if (!window.confirm(active === "1" ? "¿Activar esta cuenta?" : "¿Desactivar esta cuenta?")) return;
  try {
    await api("/api/admin/users", { method: "POST", body: JSON.stringify({ action: "set_active", userId: id, active: active === "1" }) });
    await loadUsers();
  } catch (error) {
    showError("usersError", errorText(error));
  }
}

async function assignRole(id) {
  const select = document.querySelector(`[data-role-select="${CSS.escape(id)}"]`);
  if (!select || !select.value) return;
  try {
    await api("/api/admin/users", { method: "POST", body: JSON.stringify({ action: "assign_role", userId: id, roleKey: select.value }) });
    await loadUsers();
  } catch (error) {
    showError("usersError", errorText(error));
  }
}

async function removeRole(value) {
  const [id, roleKey] = value.split("|");
  if (!window.confirm(`¿Retirar el perfil ${roleKey}?`)) return;
  try {
    await api("/api/admin/users", { method: "POST", body: JSON.stringify({ action: "remove_role", userId: id, roleKey }) });
    await loadUsers();
  } catch (error) {
    showError("usersError", errorText(error));
  }
}

async function resetPassword(id) {
  if (!window.confirm("¿Generar una contraseña temporal para esta cuenta? Se cerrarán sus sesiones.")) return;
  try {
    const result = await api("/api/admin/users", { method: "POST", body: JSON.stringify({ action: "reset_password", userId: id }) });
    showTemp(result.temporaryPassword);
  } catch (error) {
    showError("usersError", errorText(error));
  }
}

function showTemp(value) {
  $("tempValue").textContent = value || "No disponible";
  $("tempDialog").showModal();
}

async function loadAudit() {
  showError("auditError", "");
  const data = await api("/api/admin/audit");
  $("auditTable").innerHTML = `<table><thead><tr><th>Fecha</th><th>Actor</th><th>Acción</th><th>Recurso</th><th>Detalle</th></tr></thead><tbody>${(data.items || []).map((item) => `<tr><td>${fmt(item.occurred_at)}</td><td>${esc(item.actor_subject || "Sistema")}</td><td>${esc(item.event_type)}</td><td>${esc(item.resource_type)} ${esc(item.resource_id)}</td><td class="muted">${esc(JSON.stringify(item.metadata || {}))}</td></tr>`).join("") || '<tr><td colspan="5">Sin eventos.</td></tr>'}</tbody></table>`;
}

function wireEvents() {
  $("loginForm").addEventListener("submit", login);
  $("logout").addEventListener("click", logout);
  document.querySelectorAll(".tabs button[data-tab]").forEach((button) => {
    button.addEventListener("click", () => showTab(button.dataset.tab));
  });
  $("refreshRequests").addEventListener("click", () => loadRequests());
  $("requestFilter").addEventListener("change", (event) => {
    state.requestFilter = event.target.value;
    renderRequests();
  });
  $("requestsList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-request-action]");
    if (!button) return;
    const item = findRequest(button.dataset.requestId);
    if (!item) return;
    openDecision(item, button.dataset.requestAction);
  });
  $("decisionCancel").addEventListener("click", () => {
    if (!state.decisionBusy) $("decisionDialog").close();
  });
  $("decisionSubmit").addEventListener("click", submitDecision);
  $("decisionReason").addEventListener("input", () => {
    showError("decisionError", "");
    showError("decisionReasonError", "");
  });

  $("refreshBatches").addEventListener("click", () => loadBatches());
  const dropZone = $("dropZone");
  dropZone.addEventListener("click", () => $("fileInput").click());
  dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      $("fileInput").click();
    }
  });
  ["dragenter", "dragover"].forEach((name) => {
    dropZone.addEventListener(name, (event) => {
      event.preventDefault();
      dropZone.classList.add("drag");
    });
  });
  ["dragleave", "drop"].forEach((name) => {
    dropZone.addEventListener(name, (event) => {
      event.preventDefault();
      dropZone.classList.remove("drag");
    });
  });
  dropZone.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) void chooseFile(file);
  });
  $("fileInput").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) void chooseFile(file);
  });
  $("sheetSelect").addEventListener("change", (event) => {
    state.import.sheetName = event.target.value;
    state.import.mapping = {};
    void inspectFile(state.import.sheetName, state.import.headerRow);
  });
  $("headerRow").addEventListener("change", (event) => {
    state.import.headerRow = Number(event.target.value);
    state.import.mapping = {};
    void inspectFile(state.import.sheetName, state.import.headerRow);
  });
  $("mappingGrid").addEventListener("change", (event) => {
    const select = event.target.closest("[data-mapping-key]");
    if (!select) return;
    if (select.value) state.import.mapping[select.dataset.mappingKey] = select.value;
    else delete state.import.mapping[select.dataset.mappingKey];
  });
  $("prevalidateBtn").addEventListener("click", () => void prevalidate());
  $("resetImportBtn").addEventListener("click", () => {
    resetImport(true);
    $("dropZone").focus();
  });
  $("batchHistory").addEventListener("click", (event) => {
    const detailButton = event.target.closest("[data-batch-detail]");
    if (detailButton) return void loadBatchDetail(detailButton.dataset.batchDetail, false);
    const reportButton = event.target.closest("[data-batch-report]");
    if (reportButton) return void downloadReport(reportButton.dataset.batchReport);
    const confirmButton = event.target.closest("[data-batch-confirm]");
    if (confirmButton) return askConfirmBatch(confirmButton.dataset.batchConfirm);
    const cancelButton = event.target.closest("[data-batch-cancel]");
    if (cancelButton) return void cancelBatch(cancelButton.dataset.batchCancel);
  });
  $("confirmImportBtn").addEventListener("click", () => {
    if (!state.import.summary || state.import.blocked) return;
    const summary = state.import.summary;
    $("importConfirmSummary").textContent = `${summary.totalRows} fila(s): ${summary.validRows} válidas, ${summary.warningRows} con advertencias, ${summary.rejectedRows} rechazadas, ${summary.duplicateRows} duplicadas. Los ejemplares quedarán no disponibles.`;
    $("importConfirmCheck").checked = false;
    $("importConfirmSubmit").disabled = true;
    $("importConfirmDialog").showModal();
  });
  $("importConfirmCheck").addEventListener("change", (event) => {
    $("importConfirmSubmit").disabled = !event.target.checked;
  });
  $("importConfirmCancel").addEventListener("click", () => {
    if (!state.import.confirmBusy) $("importConfirmDialog").close();
  });
  $("importConfirmSubmit").addEventListener("click", () => void confirmImport());
  $("cancelImportBtn").addEventListener("click", () => {
    if (state.import.summary) void cancelBatch(state.import.summary.batchId);
  });
  $("downloadReportBtn").addEventListener("click", () => {
    if (state.import.summary) void downloadReport(state.import.summary.batchId);
  });

  $("createForm").addEventListener("submit", createUser);
  $("refreshUsers").addEventListener("click", () => loadUsers().catch((error) => showError("usersError", errorText(error))));
  $("refreshAudit").addEventListener("click", () => loadAudit().catch((error) => showError("auditError", errorText(error))));
  $("closeTemp").addEventListener("click", () => $("tempDialog").close());
  $("copyTemp").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("tempValue").textContent); } catch { /* ignore */ }
  });
  $("togglePassword").addEventListener("click", () => {
    const type = $("newPassword").type === "password" ? "text" : "password";
    ["currentPassword", "newPassword", "confirmPassword"].forEach((id) => { $(id).type = type; });
    $("togglePassword").textContent = type === "text" ? "Ocultar contraseñas" : "Mostrar contraseñas";
  });
  $("passwordForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    showError("passwordError", "");
    showSuccess("passwordSuccess", "");
    if ($("newPassword").value !== $("confirmPassword").value) {
      showError("passwordError", "La confirmación no coincide.");
      return;
    }
    const button = event.submitter;
    if (button) button.disabled = true;
    try {
      await api("/api/admin/change-password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: $("currentPassword").value,
          newPassword: $("newPassword").value,
          confirmPassword: $("confirmPassword").value,
        }),
      });
      showSuccess("passwordSuccess", "Contraseña actualizada. Inicia sesión nuevamente.");
      setTimeout(() => location.reload(), 1400);
    } catch (error) {
      showError("passwordError", errorText(error));
    } finally {
      if (button) button.disabled = false;
    }
  });
}

wireEvents();
void boot();
