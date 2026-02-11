const video = document.getElementById("video");
const statusEl = document.getElementById("status");
const captureBtn = document.getElementById("captureBtn");
const retakeBtn = document.getElementById("retakeBtn");
const outputImg = document.getElementById("outputImg");
const placeholder = document.getElementById("placeholder");
const downloadLink = document.getElementById("downloadLink");

const consentModal = document.getElementById("consentModal");
const consentAccept = document.getElementById("consentAccept");
const consentDecline = document.getElementById("consentDecline");

let stream = null;
let consentGranted = false;
let locationPermissionState = "unknown";
let cachedPosition = null;
let cachedLocationLabel = null;
let cachedLocationFetchedAt = 0;
const LOCATION_CACHE_MS = 5 * 60 * 1000;
const LOCATION_TARGET_ACCURACY_M = 40;
const LOCATION_WATCH_TIMEOUT_MS = 20000;
let hasCapture = false;
let locationPromise = null;
let locationLabelPromise = null;

function setStatus(message) {
  statusEl.textContent = message;
}

function showConsent() {
  consentModal.classList.add("show");
  consentModal.setAttribute("aria-hidden", "false");
}

function hideConsent() {
  consentModal.classList.remove("show");
  consentModal.setAttribute("aria-hidden", "true");
}

function updateReadyStatus() {
  if (!stream) {
    return;
  }
  if (hasCapture) {
    return;
  }
  if (locationPermissionState === "granted" && cachedLocationLabel) {
    setStatus(`Ready to capture. Location: ${cachedLocationLabel}.`);
    return;
  }
  if (locationPermissionState === "granted") {
    setStatus("Ready to capture. Location permission granted.");
    return;
  }
  if (locationPermissionState === "denied") {
    setStatus("Camera ready. Location permission needed for tagging.");
    return;
  }
  setStatus("Ready to capture.");
}

async function initCamera({ silent = false } = {}) {
  try {
    if (!silent) {
      setStatus("Requesting camera access...");
    }
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    captureBtn.disabled = false;
    retakeBtn.disabled = false;
    updateReadyStatus();
  } catch (error) {
    setStatus("Camera access blocked.");
  }
}

function getLocationOnce() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation not supported."));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 0,
    });
  });
}

function getBestLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation not supported."));
      return;
    }

    let bestPosition = null;
    const settle = (position) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      navigator.geolocation.clearWatch(watchId);
      if (position) {
        resolve(position);
      } else if (bestPosition) {
        resolve(bestPosition);
      } else {
        reject(new Error("Unable to resolve location."));
      }
    };

    const handleSuccess = (position) => {
      if (!bestPosition || position.coords.accuracy < bestPosition.coords.accuracy) {
        bestPosition = position;
      }
      if (position.coords.accuracy <= LOCATION_TARGET_ACCURACY_M) {
        settle(position);
      }
    };

    const handleError = () => {
      settle(null);
    };

    let settled = false;
    const watchId = navigator.geolocation.watchPosition(handleSuccess, handleError, {
      enableHighAccuracy: true,
      timeout: LOCATION_WATCH_TIMEOUT_MS,
      maximumAge: 0,
    });

    const timer = setTimeout(() => {
      settle(null);
    }, LOCATION_WATCH_TIMEOUT_MS);
  });
}

function isLocationCacheFresh() {
  return cachedPosition && Date.now() - cachedLocationFetchedAt < LOCATION_CACHE_MS;
}

async function ensureLocation() {
  if (isLocationCacheFresh()) {
    return cachedPosition;
  }
  if (locationPromise) {
    return locationPromise;
  }
  locationPromise = (async () => {
    let position = null;
    try {
      position = await getBestLocation();
    } catch (error) {
      position = await getLocationOnce();
    }
    cachedPosition = position;
    cachedLocationFetchedAt = Date.now();
    return position;
  })();
  try {
    return await locationPromise;
  } finally {
    locationPromise = null;
  }
}

function formatPlaceLabel(data) {
  if (!data) {
    return null;
  }
  const locality = data.locality || data.city || data.town || data.village || data.municipality;
  const region = data.principalSubdivision || data.region || data.state || data.county;
  const country = data.countryName || data.country;

  return locality || region || country || null;
}

async function reverseGeocode(latitude, longitude) {
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    return formatPlaceLabel(data);
  } catch (error) {
    return null;
  }
}

async function resolveLocationLabel(position) {
  if (cachedLocationLabel && isLocationCacheFresh()) {
    return cachedLocationLabel;
  }
  if (locationLabelPromise) {
    return locationLabelPromise;
  }
  locationLabelPromise = (async () => {
    const label = await reverseGeocode(position.coords.latitude, position.coords.longitude);
    cachedLocationLabel = label;
    return label;
  })();
  try {
    return await locationLabelPromise;
  } finally {
    locationLabelPromise = null;
  }
}

async function prefetchLocationPermission() {
  try {
    const position = await ensureLocation();
    locationPermissionState = "granted";
    cachedLocationLabel = await resolveLocationLabel(position);
  } catch (error) {
    locationPermissionState = "denied";
  }
  updateReadyStatus();
}

function formatTimestamp(date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

function formatExifTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function toRational(value) {
  const scaled = Math.round(value * 10000);
  return [scaled, 10000];
}

function toDmsRational(degrees) {
  const absolute = Math.abs(degrees);
  const d = Math.floor(absolute);
  const minFloat = (absolute - d) * 60;
  const m = Math.floor(minFloat);
  const secFloat = (minFloat - m) * 60;
  return [[d, 1], [m, 1], toRational(secFloat)];
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Unable to load captured image."));
    img.src = dataUrl;
  });
}

async function renderTaggedImage(baseDataUrl, metadata, locationLabel) {
  const img = await loadImage(baseDataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;

  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const padding = Math.max(18, canvas.width * 0.02);
  const fontSize = Math.max(18, canvas.width * 0.028);
  const lineHeight = fontSize * 1.3;
  const lines = [];
  lines.push(`Captured: ${formatTimestamp(metadata.timestamp)}`);
  if (locationLabel) {
    lines.push(`Location: ${locationLabel}`);
  }
  lines.push(`Lat: ${metadata.latitude.toFixed(6)}  Lon: ${metadata.longitude.toFixed(6)} (±${Math.round(metadata.accuracy)}m)`);
  const boxHeight = lineHeight * lines.length + padding * 1.2;

  ctx.fillStyle = "rgba(12, 9, 6, 0.6)";
  ctx.fillRect(0, canvas.height - boxHeight, canvas.width, boxHeight);

  ctx.fillStyle = "#ffffff";
  ctx.font = `${fontSize}px "Space Grotesk", "Segoe UI", sans-serif`;
  ctx.textBaseline = "bottom";

  let currentY = canvas.height - padding - lineHeight * (lines.length - 1);
  lines.forEach((text) => {
    ctx.fillText(text, padding, currentY);
    currentY += lineHeight;
  });

  const stampedDataUrl = canvas.toDataURL("image/jpeg", 0.92);
  return embedExif(stampedDataUrl, metadata);
}

function embedExif(dataUrl, metadata) {
  if (typeof piexif === "undefined") {
    return dataUrl;
  }

  try {
    const exifObj = {
      "0th": {},
      Exif: {},
      GPS: {},
      "1st": {},
      thumbnail: null,
    };

    exifObj["0th"][piexif.ImageIFD.DateTime] = formatExifTimestamp(metadata.timestamp);
    exifObj.Exif[piexif.ExifIFD.DateTimeOriginal] = formatExifTimestamp(metadata.timestamp);

    exifObj.GPS[piexif.GPSIFD.GPSLatitudeRef] = metadata.latitude >= 0 ? "N" : "S";
    exifObj.GPS[piexif.GPSIFD.GPSLatitude] = toDmsRational(metadata.latitude);
    exifObj.GPS[piexif.GPSIFD.GPSLongitudeRef] = metadata.longitude >= 0 ? "E" : "W";
    exifObj.GPS[piexif.GPSIFD.GPSLongitude] = toDmsRational(metadata.longitude);

    if (Number.isFinite(metadata.altitude)) {
      exifObj.GPS[piexif.GPSIFD.GPSAltitudeRef] = metadata.altitude < 0 ? 1 : 0;
      exifObj.GPS[piexif.GPSIFD.GPSAltitude] = toRational(Math.abs(metadata.altitude));
    }

    const exifBytes = piexif.dump(exifObj);
    return piexif.insert(exifBytes, dataUrl);
  } catch (error) {
    return dataUrl;
  }
}

function toggleOutput(hasOutput) {
  placeholder.style.display = hasOutput ? "none" : "block";
  outputImg.style.display = hasOutput ? "block" : "none";
  video.style.display = hasOutput ? "none" : "block";
}

function enableDownload(dataUrl, fileName) {
  downloadLink.href = dataUrl;
  downloadLink.download = fileName;
  downloadLink.classList.remove("disabled");
}

async function capture() {
  captureBtn.disabled = true;
  setStatus("Capturing image...");

  try {
    const timestamp = new Date();
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    const baseCanvas = document.createElement("canvas");
    baseCanvas.width = width;
    baseCanvas.height = height;
    const baseCtx = baseCanvas.getContext("2d");
    baseCtx.drawImage(video, 0, 0, width, height);
    const baseDataUrl = baseCanvas.toDataURL("image/jpeg", 0.92);

    outputImg.src = baseDataUrl;
    toggleOutput(true);
    hasCapture = true;
    setStatus("Tagging location...");

    const position = await ensureLocation();
    const { latitude, longitude, altitude, accuracy } = position.coords;
    const locationLabel = await resolveLocationLabel(position);

    const taggedDataUrl = await renderTaggedImage(
      baseDataUrl,
      {
        latitude,
        longitude,
        altitude,
        accuracy,
        timestamp,
      },
      locationLabel
    );

    outputImg.src = taggedDataUrl;

    const fileDate = timestamp.toISOString().slice(0, 10);
    const fileName = `Image-Verification_${fileDate}.jpg`;
    enableDownload(taggedDataUrl, fileName);

    setStatus("Captured. Output tagged.");
  } catch (error) {
    setStatus("Location access required for tagging.");
  } finally {
    captureBtn.disabled = false;
  }
}

function resetOutput() {
  outputImg.src = "";
  toggleOutput(false);
  hasCapture = false;
  downloadLink.classList.add("disabled");
  downloadLink.removeAttribute("href");
  if (stream) {
    updateReadyStatus();
  } else {
    setStatus("Consent required to start.");
  }
}

consentAccept.addEventListener("click", () => {
  consentGranted = true;
  hideConsent();
  setStatus("Requesting camera and location permissions...");
  initCamera({ silent: true });
  prefetchLocationPermission();
});

consentDecline.addEventListener("click", () => {
  consentGranted = false;
  hideConsent();
  setStatus("Consent declined. Refresh to try again.");
});

captureBtn.addEventListener("click", capture);
retakeBtn.addEventListener("click", resetOutput);
downloadLink.addEventListener("click", () => {
  if (downloadLink.classList.contains("disabled")) {
    return;
  }
  setStatus("Download started. Closing tab...");
  setTimeout(() => {
    window.close();
  }, 500);
});

resetOutput();
showConsent();
