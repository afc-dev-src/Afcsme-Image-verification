const video = document.getElementById("video");
const statusEl = document.getElementById("status");
const captureBtn = document.getElementById("captureBtn");
const retakeBtn = document.getElementById("retakeBtn");
const switchBtn = document.getElementById("switchBtn");
const cameraSelect = document.getElementById("cameraSelect");
const outputImg = document.getElementById("outputImg");
const placeholder = document.getElementById("placeholder");
const downloadLink = document.getElementById("downloadLink");
const cameraOverlay = document.getElementById("cameraOverlay");
const captureLogo = document.getElementById("captureLogo");
const captureBadge = document.getElementById("captureBadge");

const consentModal = document.getElementById("consentModal");
const consentAccept = document.getElementById("consentAccept");
const consentDecline = document.getElementById("consentDecline");

const BRAND_LOGO_SRC = "logo.png";
const CAPTURE_ASPECT_RATIO = 4 / 5;
const CAPTURE_BADGE_TEXT = "AFC SME image verification";
let stream = null;
let consentGranted = false;
let locationPermissionState = "unknown";
let cachedPosition = null;
let cachedLocationDetails = null;
let cachedLocationFetchedAt = 0;
const LOCATION_CACHE_MS = 5 * 60 * 1000;
let hasCapture = false;
let locationPromise = null;
let locationDetailsPromise = null;
let currentFacingMode = "environment";
let currentDeviceId = null;
let latestDataUrl = null;
let latestFileName = null;
let logoImagePromise = null;

function setStatus(message) {
  statusEl.textContent = message;
}

function syncActionButtons() {
  const canCapture = Boolean(stream) && !hasCapture;
  const canDownload = Boolean(latestDataUrl);

  captureBtn.classList.toggle("hidden", hasCapture);
  captureBtn.disabled = !canCapture;

  retakeBtn.classList.toggle("hidden", !hasCapture);
  retakeBtn.disabled = !hasCapture;

  downloadLink.classList.toggle("hidden", !canDownload);
  downloadLink.classList.toggle("disabled", !canDownload);
}

function showConsent() {
  consentModal.classList.add("show");
  consentModal.setAttribute("aria-hidden", "false");
}

function hideConsent() {
  consentModal.classList.remove("show");
  consentModal.setAttribute("aria-hidden", "true");
}

function stopStream() {
  if (!stream) {
    return;
  }
  stream.getTracks().forEach((track) => track.stop());
  stream = null;
}

function updateReadyStatus() {
  if (!stream) {
    return;
  }
  if (hasCapture) {
    return;
  }
  const locationSummary = formatLocationSummary(cachedLocationDetails);
  if (locationPermissionState === "granted" && locationSummary) {
    setStatus(`Ready to capture. Location: ${locationSummary}.`);
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
    stopStream();
    const constraints = {
      video: currentDeviceId
        ? { deviceId: { exact: currentDeviceId } }
        : { facingMode: { ideal: currentFacingMode } },
      audio: false,
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play();
    const track = stream.getVideoTracks()[0];
    currentDeviceId = track?.getSettings?.().deviceId || currentDeviceId;
    if (switchBtn) {
      switchBtn.disabled = false;
    }
    if (cameraSelect) {
      cameraSelect.disabled = false;
    }
    syncActionButtons();
    await updateCameraControls();
    updateReadyStatus();
  } catch (error) {
    setStatus("Camera access blocked.");
  }
}

function getLocation() {
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
    const position = await getLocation();
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

function formatLocationSummary(details) {
  if (!details) {
    return null;
  }
  const segments = [details.city, details.province].filter(Boolean);
  const countryAndZip = [details.countryCode, details.zipcode].filter(Boolean).join(" ");
  if (countryAndZip) {
    segments.push(countryAndZip);
  }
  return segments.join(", ") || null;
}

function formatPlaceDetails(data) {
  if (!data) {
    return null;
  }
  const administrativeAreas = Array.isArray(data.localityInfo?.administrative) ? data.localityInfo.administrative : [];
  const provinceEntry = administrativeAreas.find((entry) =>
    String(entry.description || "").toLowerCase().includes("province")
  );
  const province =
    provinceEntry?.name ||
    data.county ||
    data.state ||
    data.province ||
    (typeof data.principalSubdivision === "string" && !/region/i.test(data.principalSubdivision)
      ? data.principalSubdivision
      : null) ||
    null;

  return {
    city: data.locality || data.city || data.town || data.village || data.municipality || null,
    province,
    country: data.countryName || data.country || null,
    countryCode: data.countryCode || data.isoAlpha2 || data.countryCodeIsoAlpha2 || null,
    zipcode: data.postcode || data.postalCode || null,
  };
}

async function reverseGeocode(latitude, longitude) {
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    return formatPlaceDetails(data);
  } catch (error) {
    return null;
  }
}

async function resolveLocationDetails(position) {
  if (cachedLocationDetails && isLocationCacheFresh()) {
    return cachedLocationDetails;
  }
  if (locationDetailsPromise) {
    return locationDetailsPromise;
  }
  locationDetailsPromise = (async () => {
    const details = await reverseGeocode(position.coords.latitude, position.coords.longitude);
    cachedLocationDetails = details;
    return details;
  })();
  try {
    return await locationDetailsPromise;
  } finally {
    locationDetailsPromise = null;
  }
}

async function prefetchLocationPermission() {
  try {
    const position = await ensureLocation();
    locationPermissionState = "granted";
    cachedLocationDetails = await resolveLocationDetails(position);
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

function getCenteredCrop(sourceWidth, sourceHeight, targetAspectRatio) {
  const sourceAspectRatio = sourceWidth / sourceHeight;

  if (sourceAspectRatio > targetAspectRatio) {
    const cropWidth = sourceHeight * targetAspectRatio;
    return {
      sx: (sourceWidth - cropWidth) / 2,
      sy: 0,
      sw: cropWidth,
      sh: sourceHeight,
    };
  }

  const cropHeight = sourceWidth / targetAspectRatio;
  return {
    sx: 0,
    sy: (sourceHeight - cropHeight) / 2,
    sw: sourceWidth,
    sh: cropHeight,
  };
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Unable to load captured image."));
    img.src = dataUrl;
  });
}

function loadBrandLogo() {
  if (!logoImagePromise) {
    logoImagePromise = loadImage(BRAND_LOGO_SRC).catch((error) => {
      logoImagePromise = null;
      throw error;
    });
  }
  return logoImagePromise;
}

async function drawBrandLogo(ctx, canvas) {
  try {
    const logo = await loadBrandLogo();
    const badgeTop = Math.max(14, canvas.width * 0.018);
    const badgeHeight = Math.max(28, Math.min(38, canvas.width * 0.03));
    const logoLeft = Math.max(12, canvas.width * 0.018);
    const logoWidth = Math.min(canvas.width * 0.115, 84);
    const logoHeight = logo.height * (logoWidth / logo.width);
    const logoY = badgeTop + badgeHeight / 2 - logoHeight / 2;

    ctx.save();
    ctx.shadowColor = "rgba(4, 8, 16, 0.32)";
    ctx.shadowBlur = Math.max(12, canvas.width * 0.012);
    ctx.drawImage(logo, logoLeft, logoY, logoWidth, logoHeight);
    ctx.restore();
  } catch (error) {
    // Continue without branding if the local asset is unavailable.
  }
}

function addRoundedRectPath(ctx, x, y, width, height, radius) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.lineTo(x + width - safeRadius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  ctx.lineTo(x + width, y + height - safeRadius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  ctx.lineTo(x + safeRadius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  ctx.lineTo(x, y + safeRadius);
  ctx.quadraticCurveTo(x, y, x + safeRadius, y);
  ctx.closePath();
}

function drawCaptureBadge(ctx, canvas) {
  const text = CAPTURE_BADGE_TEXT.toUpperCase();
  const badgeTop = Math.max(14, canvas.width * 0.018);
  const badgePaddingX = Math.max(16, canvas.width * 0.02);
  const badgePaddingY = Math.max(7, canvas.width * 0.009);
  const badgeRadius = Math.max(12, canvas.width * 0.02);
  const maxBadgeWidth = canvas.width - Math.max(96, canvas.width * 0.19);
  let fontSize = Math.max(11, Math.min(16, canvas.width * 0.014));

  ctx.save();
  ctx.font = `600 ${fontSize}px "IBM Plex Mono", "Consolas", monospace`;

  while (ctx.measureText(text).width + badgePaddingX * 2 > maxBadgeWidth && fontSize > 8) {
    fontSize -= 1;
    ctx.font = `600 ${fontSize}px "IBM Plex Mono", "Consolas", monospace`;
  }

  const badgeWidth = Math.min(maxBadgeWidth, ctx.measureText(text).width + badgePaddingX * 2);
  const badgeHeight = fontSize + badgePaddingY * 2;
  const badgeX = (canvas.width - badgeWidth) / 2;

  ctx.shadowColor = "rgba(6, 10, 20, 0.24)";
  ctx.shadowBlur = Math.max(10, canvas.width * 0.012);
  ctx.fillStyle = "rgba(7, 10, 20, 0.72)";
  addRoundedRectPath(ctx, badgeX, badgeTop, badgeWidth, badgeHeight, badgeRadius);
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(215, 181, 109, 0.22)";
  ctx.lineWidth = Math.max(1, canvas.width * 0.0016);
  addRoundedRectPath(ctx, badgeX, badgeTop, badgeWidth, badgeHeight, badgeRadius);
  ctx.stroke();

  ctx.fillStyle = "rgba(245, 242, 234, 0.92)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, badgeTop + badgeHeight / 2 + fontSize * 0.03);
  ctx.restore();
}

function wrapCanvasText(ctx, text, maxWidth) {
  const content = String(text || "").trim();
  if (!content) {
    return ["Unavailable"];
  }

  const words = content.split(/\s+/);
  const lines = [];
  let currentLine = "";

  words.forEach((word) => {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (!currentLine || ctx.measureText(candidate).width <= maxWidth) {
      currentLine = candidate;
      return;
    }
    lines.push(currentLine);
    currentLine = word;
  });

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.length ? lines : ["Unavailable"];
}

function formatTaggedLocation(details) {
  if (!details) {
    return null;
  }

  const segments = [details.city, details.province].filter(Boolean);
  const countryAndZip = [details.countryCode, details.zipcode].filter(Boolean).join(" ");
  if (countryAndZip) {
    segments.push(countryAndZip);
  }

  return segments.join(", ") || null;
}

async function renderTaggedImage(baseDataUrl, metadata, locationDetails) {
  const img = await loadImage(baseDataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;

  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  await drawBrandLogo(ctx, canvas);
  drawCaptureBadge(ctx, canvas);

  const padding = Math.max(18, canvas.width * 0.02);
  const fontSize = Math.max(18, canvas.width * 0.028);
  const lineHeight = fontSize * 1.3;
  const maxTextWidth = canvas.width - padding * 2;
  ctx.font = `${fontSize}px "Space Grotesk", "Segoe UI", sans-serif`;
  const lines = [`Captured: ${formatTimestamp(metadata.timestamp)}`];
  const taggedLocation = formatTaggedLocation(locationDetails);

  if (taggedLocation) {
    lines.push(...wrapCanvasText(ctx, `Location: ${taggedLocation}`, maxTextWidth));
  }

  lines.push(
    ...wrapCanvasText(
      ctx,
      `Lat: ${metadata.latitude.toFixed(6)}  Lon: ${metadata.longitude.toFixed(6)} (±${Math.round(metadata.accuracy)}m)`,
      maxTextWidth
    )
  );

  const boxHeight = lineHeight * lines.length + padding * 1.2;

  ctx.fillStyle = "rgba(12, 9, 6, 0.6)";
  ctx.fillRect(0, canvas.height - boxHeight, canvas.width, boxHeight);

  ctx.fillStyle = "rgba(245, 242, 234, 0.9)";
  ctx.textBaseline = "top";
  ctx.shadowColor = "rgba(4, 8, 16, 0.22)";
  ctx.shadowBlur = Math.max(1.5, canvas.width * 0.0018);

  let currentY = canvas.height - boxHeight + padding * 0.55;
  lines.forEach((text) => {
    ctx.fillText(text, padding, currentY);
    currentY += lineHeight;
  });
  ctx.shadowBlur = 0;

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
  if (cameraOverlay) {
    cameraOverlay.classList.toggle("hidden", hasOutput);
  }
  if (captureLogo) {
    captureLogo.classList.toggle("hidden", hasOutput);
  }
  if (captureBadge) {
    captureBadge.classList.toggle("hidden", hasOutput);
  }
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isAndroid() {
  return /Android/.test(navigator.userAgent);
}

async function updateCameraControls() {
  if (!cameraSelect || !switchBtn) {
    return;
  }
  const isMobile = isIOS() || isAndroid();
  switchBtn.style.display = isMobile ? "inline-flex" : "none";
  cameraSelect.style.display = isMobile ? "none" : "inline-flex";

  if (!isMobile) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter((device) => device.kind === "videoinput");
      cameraSelect.innerHTML = "";
      videoDevices.forEach((device, index) => {
        const option = document.createElement("option");
        option.value = device.deviceId;
        option.textContent = device.label || `Camera ${index + 1}`;
        cameraSelect.appendChild(option);
      });
      if (currentDeviceId) {
        cameraSelect.value = currentDeviceId;
      }
      cameraSelect.disabled = videoDevices.length < 2;
    } catch (error) {
      cameraSelect.disabled = true;
    }
  }
}

function enableDownload(dataUrl, fileName) {
  latestDataUrl = dataUrl;
  latestFileName = fileName;
  downloadLink.href = dataUrl;
  downloadLink.download = fileName;
  syncActionButtons();
}

async function capture() {
  captureBtn.disabled = true;
  setStatus("Capturing image...");

  try {
    const timestamp = new Date();
    const sourceWidth = video.videoWidth || 1280;
    const sourceHeight = video.videoHeight || 720;
    const crop = getCenteredCrop(sourceWidth, sourceHeight, CAPTURE_ASPECT_RATIO);
    const baseCanvas = document.createElement("canvas");
    baseCanvas.width = Math.round(crop.sw);
    baseCanvas.height = Math.round(crop.sh);
    const baseCtx = baseCanvas.getContext("2d");
    baseCtx.drawImage(
      video,
      crop.sx,
      crop.sy,
      crop.sw,
      crop.sh,
      0,
      0,
      baseCanvas.width,
      baseCanvas.height
    );
    const baseDataUrl = baseCanvas.toDataURL("image/jpeg", 0.92);

    outputImg.src = baseDataUrl;
    toggleOutput(true);
    hasCapture = true;
    syncActionButtons();
    setStatus("Tagging location...");

    const position = await ensureLocation();
    const { latitude, longitude, altitude, accuracy } = position.coords;
    const locationDetails = await resolveLocationDetails(position);

    const taggedDataUrl = await renderTaggedImage(
      baseDataUrl,
      {
        latitude,
        longitude,
        altitude,
        accuracy,
        timestamp,
      },
      locationDetails
    );

    outputImg.src = taggedDataUrl;

    const fileDate = timestamp.toISOString().slice(0, 10);
    const fileName = `Image-Verification_${fileDate}.jpg`;
    enableDownload(taggedDataUrl, fileName);

    setStatus("Captured. Output tagged.");
  } catch (error) {
    latestDataUrl = null;
    latestFileName = null;
    syncActionButtons();
    setStatus("Location access required for tagging. Retake or allow location and try again.");
  } finally {
    syncActionButtons();
  }
}

function resetOutput() {
  outputImg.src = "";
  toggleOutput(false);
  hasCapture = false;
  latestDataUrl = null;
  latestFileName = null;
  downloadLink.removeAttribute("href");
  downloadLink.removeAttribute("download");
  syncActionButtons();
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
if (switchBtn) {
  switchBtn.addEventListener("click", () => {
    currentFacingMode = currentFacingMode === "environment" ? "user" : "environment";
    currentDeviceId = null;
    setStatus("Switching camera...");
    initCamera({ silent: true });
  });
}

if (cameraSelect) {
  cameraSelect.addEventListener("change", () => {
    if (!cameraSelect.value) {
      return;
    }
    currentDeviceId = cameraSelect.value;
    setStatus("Switching camera...");
    initCamera({ silent: true });
  });
}

downloadLink.addEventListener("click", async (event) => {
  if (downloadLink.classList.contains("disabled")) {
    return;
  }
  if ((isIOS() || isAndroid()) && latestDataUrl && latestFileName) {
    event.preventDefault();
    try {
      const blob = await (await fetch(latestDataUrl)).blob();
      const file = new File([blob], latestFileName, { type: "image/jpeg" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "Image Verification" });
        return;
      }
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      return;
    } catch (error) {
      window.open(latestDataUrl, "_blank");
      return;
    }
  }
  setStatus("Download started.");
});

resetOutput();
showConsent();
