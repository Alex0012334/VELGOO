const DRIVE_FOLDER_ID = "1XbaqBJIku3pfH87Rd-A6Zhuwx789DBQC";
const STATE_FILE_NAME = "VELGO-data.json";
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function doGet(e) {
  const action = String(e.parameter.action || "load");
  if (action === "load") {
    return jsonp_(e.parameter.callback, loadState_());
  }
  if (action === "file") {
    const fileId = String(e.parameter.fileId || "");
    if (!fileId) throw new Error("Missing fileId.");
    const file = DriveApp.getFileById(fileId);
    if (!isInConfiguredFolder_(file)) throw new Error("File is not in the configured folder.");
    return jsonp_(e.parameter.callback, {
      id: file.getId(),
      name: file.getName(),
      mimeType: file.getMimeType(),
      base64: Utilities.base64Encode(file.getBlob().getBytes())
    });
  }
  throw new Error("Unsupported action.");
}

function doPost(e) {
  let requestId = "";
  try {
    const request = JSON.parse(e.parameter.payload || "{}");
    requestId = String(request.requestId || "");
    const action = String(request.action || "");
    let result;

    if (action === "saveState") {
      result = saveState_(request.state, request.baseState);
    } else if (action === "uploadFile") {
      result = uploadFile_(request);
    } else if (action === "deleteFile") {
      result = deleteFile_(request.fileId);
    } else {
      throw new Error("Unsupported action.");
    }

    return postMessageResponse_({ requestId: String(request.requestId || ""), ok: true, result: result });
  } catch (error) {
    return postMessageResponse_({ requestId: requestId, ok: false, error: String(error.message || error) });
  }
}

function loadState_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const file = findStateFile_();
    if (!file) return null;
    return JSON.parse(file.getBlob().getDataAsString("UTF-8"));
  } finally {
    lock.releaseLock();
  }
}

function saveState_(state, baseState) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("Invalid platform state.");
  }

  const publicState = Object.assign({}, state);
  delete publicState.adminPassword;
  baseState = baseState && typeof baseState === "object" && !Array.isArray(baseState) ? baseState : null;
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const file = findStateFile_();
    let mergedState = publicState;
    if (file) {
      if (!baseState) {
        throw new Error("This app version cannot safely sync shared changes. Reload the page and try again.");
      }
      const currentEnvelope = JSON.parse(file.getBlob().getDataAsString("UTF-8"));
      if (currentEnvelope.state) {
        mergedState = mergeConcurrentState_(baseState, publicState, currentEnvelope.state);
      }
      const updatedAt = new Date().toISOString();
      file.setContent(JSON.stringify({
        schemaVersion: 1,
        updatedAt: updatedAt,
        state: mergedState
      }));
      return { fileId: file.getId(), updatedAt: updatedAt, state: mergedState };
    }

    const updatedAt = new Date().toISOString();
    const created = getFolder_().createFile(
      STATE_FILE_NAME,
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: updatedAt,
        state: mergedState
      }),
      MimeType.PLAIN_TEXT
    );
    return { fileId: created.getId(), updatedAt: updatedAt, state: mergedState };
  } finally {
    lock.releaseLock();
  }
}

function mergeConcurrentState_(base, local, remote) {
  if (sameJson_(local, base)) return remote;
  if (sameJson_(remote, base) || sameJson_(local, remote)) return local;

  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote) &&
      [...base, ...local, ...remote].every(item => item && typeof item === "object" && !Array.isArray(item) && item.id)) {
    const baseById = new Map(base.map(item => [String(item.id), item]));
    const localById = new Map(local.map(item => [String(item.id), item]));
    const remoteById = new Map(remote.map(item => [String(item.id), item]));
    const ids = [...new Set([...localById.keys(), ...remoteById.keys()])];
    const merged = [];
    ids.forEach(itemId => {
      const inBase = baseById.has(itemId);
      const inLocal = localById.has(itemId);
      const inRemote = remoteById.has(itemId);
      if (!inLocal && !inRemote) return;
      if (inBase && !inLocal) {
        if (!sameJson_(remoteById.get(itemId), baseById.get(itemId))) merged.push(remoteById.get(itemId));
        return;
      }
      if (inBase && !inRemote) {
        if (!sameJson_(localById.get(itemId), baseById.get(itemId))) merged.push(localById.get(itemId));
        return;
      }
      if (inLocal && inRemote) {
        merged.push(inBase
          ? mergeConcurrentState_(baseById.get(itemId), localById.get(itemId), remoteById.get(itemId))
          : mergeConcurrentState_({}, localById.get(itemId), remoteById.get(itemId)));
      } else {
        merged.push(inLocal ? localById.get(itemId) : remoteById.get(itemId));
      }
    });
    return merged;
  }

  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
    const isAppendOnly = items => base.every((item, index) => sameJson_(item, items[index]));
    if (isAppendOnly(local) && isAppendOnly(remote)) {
      const merged = base.slice();
      [...local.slice(base.length), ...remote.slice(base.length)].forEach(item => {
        if (!merged.some(existing => sameJson_(existing, item))) merged.push(item);
      });
      return merged;
    }
  }

  if (isPlainObject_(base) && isPlainObject_(local) && isPlainObject_(remote)) {
    const result = {};
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
    keys.forEach(key => {
      const hasBase = Object.prototype.hasOwnProperty.call(base, key);
      const hasLocal = Object.prototype.hasOwnProperty.call(local, key);
      const hasRemote = Object.prototype.hasOwnProperty.call(remote, key);
      const value = mergeConcurrentState_(
        hasBase ? base[key] : undefined,
        hasLocal ? local[key] : undefined,
        hasRemote ? remote[key] : undefined
      );
      if (value !== undefined) result[key] = value;
    });
    return result;
  }

  return local;
}

function isPlainObject_(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameJson_(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function uploadFile_(request) {
  const name = String(request.name || "").trim();
  const base64 = String(request.base64 || "");
  if (!name || !base64) throw new Error("File name and content are required.");

  const estimatedBytes = Math.floor(base64.length * 3 / 4);
  if (estimatedBytes > MAX_FILE_BYTES) {
    throw new Error("Files larger than 20 MB are not supported.");
  }

  const bytes = Utilities.base64Decode(base64);
  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error("Files larger than 20 MB are not supported.");
  }
  const mimeType = String(request.mimeType || "application/octet-stream");
  const blob = Utilities.newBlob(bytes, mimeType, name);
  const file = getFolder_().createFile(blob);
  return {
    id: file.getId(),
    name: file.getName(),
    mimeType: file.getMimeType(),
    size: file.getSize()
  };
}

function deleteFile_(fileId) {
  const id = String(fileId || "");
  if (!id) throw new Error("Missing fileId.");

  const file = DriveApp.getFileById(id);
  if (!isInConfiguredFolder_(file)) throw new Error("File is not in the configured folder.");

  file.setTrashed(true);
  return { id: id, deleted: true };
}

function isInConfiguredFolder_(file) {
  const parents = file.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === DRIVE_FOLDER_ID) return true;
  }
  return false;
}

function postMessageResponse_(payload) {
  const message = JSON.stringify(payload).replace(/</g, "\\u003c");
  return HtmlService
    .createHtmlOutput("<script>window.top.postMessage(" + message + ", '*');</script>")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function findStateFile_() {
  const files = getFolder_().getFilesByName(STATE_FILE_NAME);
  return files.hasNext() ? files.next() : null;
}

function getFolder_() {
  return DriveApp.getFolderById(DRIVE_FOLDER_ID);
}

function jsonp_(callback, value) {
  const name = String(callback || "");
  if (!/^[\w.$]{1,120}$/.test(name)) {
    throw new Error("A valid JSONP callback is required.");
  }

  const json = JSON.stringify(value).replace(/</g, "\\u003c");
  return ContentService
    .createTextOutput(name + "(" + json + ");")
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}
