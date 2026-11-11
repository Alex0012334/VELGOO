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
      result = saveState_(request.state);
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

function saveState_(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("Invalid platform state.");
  }

  const publicState = Object.assign({}, state);
  delete publicState.adminPassword;
  const content = JSON.stringify({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    state: publicState
  });
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const file = findStateFile_();
    if (file) {
      file.setContent(content);
      return { fileId: file.getId(), updatedAt: new Date().toISOString() };
    }

    const created = getFolder_().createFile(
      STATE_FILE_NAME,
      content,
      MimeType.PLAIN_TEXT
    );
    return { fileId: created.getId(), updatedAt: new Date().toISOString() };
  } finally {
    lock.releaseLock();
  }
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
