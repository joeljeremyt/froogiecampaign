// Froogie Selfie Filter - Campaign "Unfroogetably Sour!"
// Live camera with face landmark tracking and fruit leather tongue filter

import {
  FilesetResolver,
  FaceLandmarker
} from './tasks-vision.js';

// DOM Elements
const screens = {
  camera: document.getElementById('screen-camera'),
  preview: document.getElementById('screen-preview'),
  email: document.getElementById('screen-email')
};

// Controls & Overlays
const btnTakePhoto = document.getElementById('btn-take-photo');
const btnRetake = document.getElementById('btn-retake');
const btnSendProceed = document.getElementById('btn-send-proceed');
const btnSendEmail = document.getElementById('btn-send-email');
const btnRetryCamera = document.getElementById('btn-retry-camera');
const btnStartDemo = document.getElementById('btn-start-demo');
const btnTakeAnother = document.getElementById('btn-take-another');

const cameraControls = document.getElementById('camera-active-controls');
const cameraErrorOverlay = document.getElementById('camera-error-overlay');
const cameraErrorMessage = document.getElementById('camera-error-message');
const mouthInstructionEl = document.getElementById('mouth-instruction');

const videoEl = document.getElementById('camera-video');
const filterCanvas = document.getElementById('filter-canvas');
const filterCtx = filterCanvas.getContext('2d');
const compositeCanvas = document.getElementById('composite-canvas');
const compositeCtx = compositeCanvas.getContext('2d');

const previewImageEl = document.getElementById('preview-image');
const emailFormSection = document.getElementById('email-form-section');
const emailSuccessSection = document.getElementById('email-success-section');
const emailSuccessDesc = document.getElementById('email-success-desc');
const emailInputEl = document.getElementById('email-input');
const emailErrorBanner = document.getElementById('email-error-banner');

// Campaign Assets
const frameImg = new Image();
frameImg.src = 'asset/image/campaigninteractive-frame.png';

const logoImg = new Image();
logoImg.src = 'asset/image/campaigninteractive-logo.png';

const tongueImg = new Image();
tongueImg.src = 'asset/image/fruitleather-tongue.png';

// State
let faceLandmarker = null;
let isModelInitializing = false;
let mediaStream = null;
let animationFrameId = null;
let capturedDataUrl = null;
let isCameraRunning = false;

// Tongue bounds in fruitleather-tongue.png (1181 x 3543)
// Leather bounds: X=250..1010 (width 760), Y=115..3340 (height 3225)
const TONGUE_CROP = {
  x: 250,
  y: 115,
  width: 760,
  height: 3225
};

// Tracking & smoothing state
let isMouthOpen = false;
let tongueProgress = 0.0; // 0.0 (retracted) to 1.0 (fully extended)
let hasTrackedFace = false;

let smoothAnchorX = 0;
let smoothAnchorY = 0;
let smoothAngle = Math.PI / 2;
let smoothMouthW = 80;

// Simulation mode variables (if webcam is unavailable)
let isSimulated = false;

// Screen management
function showScreen(screenName) {
  Object.keys(screens).forEach(key => {
    if (key === screenName) {
      screens[key].classList.add('active');
    } else {
      screens[key].classList.remove('active');
    }
  });

  // Stop camera stream whenever leaving the camera screen
  if (screenName !== 'camera') {
    stopCamera();
  }
}

// Initialize MediaPipe Face Landmarker in background
async function initFaceLandmarker() {
  if (faceLandmarker) return faceLandmarker;
  if (isModelInitializing) return null;

  isModelInitializing = true;
  try {
    // 1. Resolve vision tasks wasm (try local first, fallback to CDN)
    let vision = null;
    try {
      vision = await FilesetResolver.forVisionTasks('./asset/wasm');
    } catch (localWasmErr) {
      console.warn('Local wasm failed, falling back to CDN...', localWasmErr);
      vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
      );
    }

    // 2. Load face landmarker model
    const modelPaths = [
      './asset/models/face_landmarker.task',
      'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
    ];

    let landmarkerInstance = null;
    for (const modelPath of modelPaths) {
      try {
        landmarkerInstance = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: modelPath,
            delegate: 'GPU'
          },
          outputFaceBlendshapes: true,
          runningMode: 'VIDEO',
          numFaces: 1
        });
        if (landmarkerInstance) break;
      } catch (errGPU) {
        console.warn(`GPU delegate failed with ${modelPath}, trying CPU...`, errGPU);
        try {
          landmarkerInstance = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: modelPath,
              delegate: 'CPU'
            },
            outputFaceBlendshapes: true,
            runningMode: 'VIDEO',
            numFaces: 1
          });
          if (landmarkerInstance) break;
        } catch (errCPU) {
          console.warn(`Failed with ${modelPath}:`, errCPU);
        }
      }
    }

    if (!landmarkerInstance) {
      throw new Error('Could not load Face Landmarker model');
    }

    faceLandmarker = landmarkerInstance;
    console.log('🐸 Face Landmarker initialized successfully');
    return faceLandmarker;
  } catch (err) {
    console.error('Face Landmarker init error:', err);
    return null;
  } finally {
    isModelInitializing = false;
  }
}

// Multi-strategy camera acquisition (works on mobile, tablet, laptop, and desktop webcams)
async function requestCameraStream() {
  // Strategy 1: Ideal front camera for mobile/tablet with standard resolution
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'user' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    });
  } catch (err1) {
    console.warn('Strategy 1 failed, trying Strategy 2...', err1);
  }

  // Strategy 2: User facing mode without resolution constraints
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user'
      }
    });
  } catch (err2) {
    console.warn('Strategy 2 failed, trying Strategy 3...', err2);
  }

  // Strategy 3: Basic video stream (guaranteed to work with built-in laptop and external USB webcams)
  return await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: true
  });
}

// Start Camera Stream immediately
async function startCamera() {
  console.log('Starting camera automatically...');
  showScreen('camera');
  cameraErrorOverlay.classList.add('hidden');
  mouthInstructionEl.classList.remove('hidden');

  // Trigger model loading early in background
  initFaceLandmarker();

  // Validate Secure Context / mediaDevices support
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.error('navigator.mediaDevices is unavailable');
    const isFileProto = window.location.protocol === 'file:';
    const errText = isFileProto
      ? 'Camera access is blocked by browsers when opening via file://. Please open via http://localhost:3000.'
      : 'Camera access requires a secure context (HTTPS or http://localhost). Please open http://localhost:3000.';
    showCameraError(errText);
    return;
  }

  try {
    mediaStream = await requestCameraStream();
    console.log('Got camera stream successfully');

    videoEl.muted = true;
    videoEl.defaultMuted = true;
    videoEl.playsInline = true;
    videoEl.setAttribute('playsinline', '');
    videoEl.setAttribute('muted', '');
    videoEl.srcObject = mediaStream;
    isSimulated = false;

    // Wait until video has enough data to render frames
    await new Promise((resolve) => {
      if (videoEl.readyState >= 2) {
        resolve();
      } else {
        const onReady = () => {
          videoEl.removeEventListener('loadeddata', onReady);
          videoEl.removeEventListener('loadedmetadata', onReady);
          resolve();
        };
        videoEl.addEventListener('loadeddata', onReady);
        videoEl.addEventListener('loadedmetadata', onReady);
        setTimeout(resolve, 2000);
      }
    });

    try {
      await videoEl.play();
    } catch (playErr) {
      console.warn('video.play() warning:', playErr);
    }

    isCameraRunning = true;
    cameraErrorOverlay.classList.add('hidden');
    cameraControls.classList.remove('hidden');
    mouthInstructionEl.classList.remove('hidden');

    resizeCanvas();
    startTrackingLoop();
  } catch (err) {
    console.error('Real camera error:', err.name, err.message, err);

    let msg = `Could not access camera (${err.name || 'Error'}).`;
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      msg = 'Camera permission was denied. Please click the camera/lock icon in your browser address bar to allow camera access, then click Enable Camera.';
    } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      msg = 'No camera device was detected. You can run the interactive demo to test the fruit leather tongue filter!';
    } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
      msg = 'Camera is currently in use by another application or browser tab. Please close other apps using the webcam and click Enable Camera.';
    } else if (err.name === 'OverconstrainedError') {
      msg = 'Camera resolution constraints not satisfied by device hardware.';
    }
    showCameraError(msg);
  }
}

// Stop Camera Stream
function stopCamera() {
  isCameraRunning = false;
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => {
      try { track.stop(); } catch (e) { }
    });
    mediaStream = null;
  }
  if (videoEl) {
    videoEl.srcObject = null;
  }

  filterCtx.clearRect(0, 0, filterCanvas.width, filterCanvas.height);
  hasTrackedFace = false;
  tongueProgress = 0.0;
  isMouthOpen = false;
  mouthInstructionEl.classList.add('hidden');
}

// Show camera error overlay with options
function showCameraError(message) {
  cameraErrorMessage.textContent = message;
  cameraErrorOverlay.classList.remove('hidden');
}

// Simulated Camera (fallback for testing without webcam)
function startSimulatedCamera() {
  cameraErrorOverlay.classList.add('hidden');
  cameraControls.classList.remove('hidden');
  mouthInstructionEl.classList.remove('hidden');

  isSimulated = true;
  isCameraRunning = true;

  const simCanvas = document.createElement('canvas');
  simCanvas.width = 640;
  simCanvas.height = 480;
  const sCtx = simCanvas.getContext('2d');

  const stream = simCanvas.captureStream(30);
  videoEl.srcObject = stream;
  videoEl.play().catch(() => { });

  function drawSim() {
    if (!isSimulated || !isCameraRunning) return;

    // Background gradient
    const grad = sCtx.createLinearGradient(0, 0, simCanvas.width, simCanvas.height);
    grad.addColorStop(0, '#fde047');
    grad.addColorStop(1, '#a3e635');
    sCtx.fillStyle = grad;
    sCtx.fillRect(0, 0, simCanvas.width, simCanvas.height);

    // Person face silhouette
    sCtx.fillStyle = '#fbd38d';
    sCtx.beginPath();
    sCtx.arc(320, 220, 110, 0, Math.PI * 2);
    sCtx.fill();

    // Eyes
    sCtx.fillStyle = '#1e1b2e';
    sCtx.beginPath();
    sCtx.arc(280, 195, 12, 0, Math.PI * 2);
    sCtx.arc(360, 195, 12, 0, Math.PI * 2);
    sCtx.fill();

    // Animated mouth cycle (opens every 4s for 2s)
    const now = performance.now();
    const cycle = (now % 4000);
    const mouthOpen = cycle > 1000 && cycle < 3000;
    const mouthHeight = mouthOpen ? 32 : 6;

    sCtx.fillStyle = '#7f1d1d';
    sCtx.beginPath();
    sCtx.ellipse(320, 260, 36, mouthHeight, 0, 0, Math.PI * 2);
    sCtx.fill();

    requestAnimationFrame(drawSim);
  }
  drawSim();

  resizeCanvas();
  startTrackingLoop();
}

// Resize filter canvas to exact container size
function resizeCanvas() {
  const rect = videoEl.getBoundingClientRect();
  const width = Math.round(rect.width) || videoEl.videoWidth || 800;
  const height = Math.round(rect.height) || videoEl.videoHeight || 600;

  if (filterCanvas.width !== width || filterCanvas.height !== height) {
    filterCanvas.width = width;
    filterCanvas.height = height;
  }
}

window.addEventListener('resize', () => {
  if (isCameraRunning && screens.camera.classList.contains('active')) {
    resizeCanvas();
  }
});

// Compute exact mapping from normalized video coordinates to cover-fitted canvas
function getVideoCoverTransform(vw, vh, cw, ch) {
  const videoAspect = vw / vh;
  const canvasAspect = cw / ch;

  let drawW, drawH, offsetX, offsetY;
  if (videoAspect > canvasAspect) {
    // Video is wider than canvas: height matches, left/right cropped
    drawH = ch;
    drawW = ch * videoAspect;
    offsetX = (cw - drawW) / 2;
    offsetY = 0;
  } else {
    // Video is taller than canvas: width matches, top/bottom cropped
    drawW = cw;
    drawH = cw / videoAspect;
    offsetX = 0;
    offsetY = (ch - drawH) / 2;
  }

  return {
    toCanvasX: (normX) => offsetX + (1 - normX) * drawW, // Mirrored horizontally
    toCanvasY: (normY) => offsetY + normY * drawH
  };
}

// Main Tracking & Render Loop
function startTrackingLoop() {
  let lastVideoTime = -1;

  function render() {
    if (!isCameraRunning || !screens.camera.classList.contains('active')) return;

    resizeCanvas();
    const cw = filterCanvas.width;
    const ch = filterCanvas.height;

    let faceFound = false;
    let targetAnchorX = cw / 2;
    let targetAnchorY = ch * 0.54;
    let targetDownAngle = Math.PI / 2;
    let targetMouthW = cw * 0.18;
    let currentOpen = false;

    // 1. Simulated mode
    if (isSimulated) {
      faceFound = true;
      targetAnchorX = cw / 2;
      targetAnchorY = ch * 0.54;
      targetDownAngle = Math.PI / 2;
      targetMouthW = cw * 0.18;

      const now = performance.now();
      const cycle = (now % 4000);
      currentOpen = cycle > 1000 && cycle < 3000;
    }
    // 2. Real camera tracking with MediaPipe
    else if (faceLandmarker && videoEl.readyState >= 2) {
      if (videoEl.currentTime !== lastVideoTime) {
        lastVideoTime = videoEl.currentTime;

        const results = faceLandmarker.detectForVideo(videoEl, performance.now());
        if (results && results.faceLandmarks && results.faceLandmarks.length > 0) {
          faceFound = true;
          const lm = results.faceLandmarks[0];

          const vw = videoEl.videoWidth || 640;
          const vh = videoEl.videoHeight || 480;
          const { toCanvasX, toCanvasY } = getVideoCoverTransform(vw, vh, cw, ch);

          // Key landmarks:
          // 13: Inner upper lip center
          // 14: Inner lower lip center
          // 61: Mouth corner left (from subject's perspective)
          // 291: Mouth corner right
          // 152: Chin bottom
          const p13 = lm[13];
          const p14 = lm[14];
          const p61 = lm[61];
          const p291 = lm[291];
          const p152 = lm[152];

          // Tongue anchor positioned where tongue emerges (upper mouth / upper lip)
          targetAnchorX = toCanvasX((p13.x + p14.x) / 2);
          targetAnchorY = toCanvasY(p13.y * 0.75 + p14.y * 0.25);

          // Direction vector from mouth anchor to chin gives the exact face tilt & downward orientation
          const chinX = toCanvasX(p152.x);
          const chinY = toCanvasY(p152.y);
          targetDownAngle = Math.atan2(chinY - targetAnchorY, chinX - targetAnchorX);

          // Mouth width in pixels
          const cornerLeftX = toCanvasX(p61.x);
          const cornerLeftY = toCanvasY(p61.y);
          const cornerRightX = toCanvasX(p291.x);
          const cornerRightY = toCanvasY(p291.y);
          targetMouthW = Math.hypot(cornerRightX - cornerLeftX, cornerRightY - cornerLeftY);

          // Measure mouth opening height & ratio
          const mouthOpenDist = Math.hypot(toCanvasX(p14.x) - toCanvasX(p13.x), toCanvasY(p14.y) - toCanvasY(p13.y));
          const openRatio = mouthOpenDist / Math.max(12, targetMouthW);

          // Jaw open score from blendshapes
          const jawOpenScore = results.faceBlendshapes?.[0]?.categories?.find(
            c => c.categoryName === 'jawOpen'
          )?.score || 0;

          // Hysteresis threshold to prevent flickering
          if (isMouthOpen) {
            currentOpen = (jawOpenScore > 0.11) || (openRatio > 0.12);
          } else {
            currentOpen = (jawOpenScore > 0.17) || (openRatio > 0.17);
          }
        }
      } else {
        faceFound = hasTrackedFace;
        currentOpen = isMouthOpen;
      }
    }

    isMouthOpen = currentOpen;

    // Smooth coordinates using exponential moving average for jitter-free tracking
    if (faceFound) {
      if (!hasTrackedFace) {
        smoothAnchorX = targetAnchorX;
        smoothAnchorY = targetAnchorY;
        smoothAngle = targetDownAngle;
        smoothMouthW = targetMouthW;
        hasTrackedFace = true;
      } else {
        smoothAnchorX += (targetAnchorX - smoothAnchorX) * 0.55;
        smoothAnchorY += (targetAnchorY - smoothAnchorY) * 0.55;
        smoothMouthW += (targetMouthW - smoothMouthW) * 0.45;

        // Angle diff wrap-around
        let dAngle = targetDownAngle - smoothAngle;
        while (dAngle < -Math.PI) dAngle += Math.PI * 2;
        while (dAngle > Math.PI) dAngle -= Math.PI * 2;
        smoothAngle += dAngle * 0.45;
      }
    }

    // Tongue animation physics (quick frog-like extension, swift retraction)
    if (faceFound && isMouthOpen) {
      tongueProgress += (1.0 - tongueProgress) * 0.28;
      if (tongueProgress > 0.99) tongueProgress = 1.0;
    } else {
      tongueProgress += (0.0 - tongueProgress) * 0.32;
      if (tongueProgress < 0.02) tongueProgress = 0.0;
    }

    // Instruction logic:
    // Visible while mouth is closed, hides when mouth opens and tongue extends
    if (tongueProgress > 0.04 || isMouthOpen) {
      mouthInstructionEl.classList.add('hidden');
    } else {
      mouthInstructionEl.classList.remove('hidden');
    }

    // Draw Tongue on Filter Canvas
    filterCtx.clearRect(0, 0, cw, ch);

    if (hasTrackedFace && tongueProgress > 0.01 && tongueImg.complete) {
      renderTongue(filterCtx, smoothAnchorX, smoothAnchorY, smoothAngle, smoothMouthW, tongueProgress);
    }

    animationFrameId = requestAnimationFrame(render);
  }

  animationFrameId = requestAnimationFrame(render);
}

// Draw the fruit leather tongue attached to the mouth
function renderTongue(ctx, anchorX, anchorY, downAngle, mouthW, progress) {
  ctx.save();
  ctx.translate(anchorX, anchorY);
  // Align canvas Y axis with downAngle (direction from mouth to chin)
  ctx.rotate(downAngle - Math.PI / 2);

  // Tongue width proportional to mouth
  const tongueW = Math.max(28, mouthW * 0.95);
  // Full length based on image aspect ratio
  const fullLength = tongueW * (TONGUE_CROP.height / TONGUE_CROP.width) * 0.88;
  const currentLength = fullLength * progress;

  // Source slice from cropped leather bounds (eliminates top transparent padding)
  const srcHeight = TONGUE_CROP.height * progress;

  ctx.drawImage(
    tongueImg,
    TONGUE_CROP.x, TONGUE_CROP.y, TONGUE_CROP.width, srcHeight,
    -tongueW / 2, 0, tongueW, currentLength
  );

  ctx.restore();
}

// Composite final photo onto canvas
function captureCompositePhoto() {
  const cw = filterCanvas.width || 800;
  const ch = filterCanvas.height || 600;
  const aspect = cw / ch;

  // High-res composite canvas matching display aspect ratio
  let compW = 1440;
  let compH = Math.round(1440 / aspect);
  if (aspect < 1) {
    // Portrait mode on mobile
    compH = 1440;
    compW = Math.round(1440 * aspect);
  }

  compositeCanvas.width = compW;
  compositeCanvas.height = compH;

  // 1. Draw camera video (mirrored horizontally to match CSS scaleX(-1))
  compositeCtx.save();
  compositeCtx.translate(compW, 0);
  compositeCtx.scale(-1, 1);

  const vw = videoEl.videoWidth || 640;
  const vh = videoEl.videoHeight || 480;
  const videoAspect = vw / vh;
  const canvasAspect = compW / compH;

  let drawW, drawH, offsetX, offsetY;
  if (videoAspect > canvasAspect) {
    drawH = compH;
    drawW = compH * videoAspect;
    offsetX = (compW - drawW) / 2;
    offsetY = 0;
  } else {
    drawW = compW;
    drawH = compW / videoAspect;
    offsetX = 0;
    offsetY = (compH - drawH) / 2;
  }

  // Draw mirrored video covering the canvas (offsetX is negative when wider, centered)
  compositeCtx.drawImage(
    videoEl,
    offsetX, offsetY, drawW, drawH
  );
  compositeCtx.restore();

  // 2. Draw fruit leather tongue at scaled composite coordinates
  if (hasTrackedFace && tongueProgress > 0.01 && tongueImg.complete) {
    const scaleX = compW / cw;
    const scaleY = compH / ch;
    const compAnchorX = smoothAnchorX * scaleX;
    const compAnchorY = smoothAnchorY * scaleY;
    const compMouthW = smoothMouthW * scaleX;

    renderTongue(compositeCtx, compAnchorX, compAnchorY, smoothAngle, compMouthW, tongueProgress);
  }

  // 3. Draw campaigninteractive-frame.png overlay covering entire canvas
  if (frameImg.complete) {
    compositeCtx.drawImage(frameImg, 0, 0, compW, compH);
  }

  // 4. Draw campaigninteractive-logo.png overlay at top-left
  if (logoImg.complete) {
    const logoW = compW * 0.27;
    const logoH = logoW * (logoImg.naturalHeight / logoImg.naturalWidth);
    const logoX = compW * 0.035;
    const logoY = compH * 0.025;
    compositeCtx.drawImage(logoImg, logoX, logoY, logoW, logoH);
  }

  // Export to JPEG Data URL
  return compositeCanvas.toDataURL('image/jpeg', 0.92);
}

// Event Listeners

// Retry / Demo buttons on error overlay
btnRetryCamera.addEventListener('click', () => {
  startCamera();
});

btnStartDemo.addEventListener('click', () => {
  startSimulatedCamera();
});

// Take Photo
btnTakePhoto.addEventListener('click', () => {
  capturedDataUrl = captureCompositePhoto();
  previewImageEl.src = capturedDataUrl;
  showScreen('preview');
});

// Preview: RETAKE -> Return to camera
btnRetake.addEventListener('click', () => {
  startCamera();
});

// Preview: SEND PHOTO -> Proceed to email
btnSendProceed.addEventListener('click', () => {
  emailFormSection.classList.remove('hidden');
  emailSuccessSection.classList.add('hidden');
  emailErrorBanner.classList.add('hidden');
  btnSendEmail.disabled = false;
  btnSendEmail.innerHTML = '<span>SEND MY SELFIE</span>';

  showScreen('email');
});

// Email: Send Form Submission
document.getElementById('email-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const email = emailInputEl.value.trim();
  if (!email || !email.includes('@')) {
    emailErrorBanner.textContent = 'Please enter a valid email address.';
    emailErrorBanner.classList.remove('hidden');
    return;
  }

  if (!capturedDataUrl) {
    emailErrorBanner.textContent = 'Selfie photo data is missing. Please retake your selfie.';
    emailErrorBanner.classList.remove('hidden');
    return;
  }

  // Loading state
  btnSendEmail.disabled = true;
  btnSendEmail.innerHTML = '<span class="spinner"></span> <span>SENDING SELFIE...</span>';
  emailErrorBanner.classList.add('hidden');

  try {
    const response = await fetch('/api/send-email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        imageBase64: capturedDataUrl
      })
    });

    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Failed to dispatch email. Please try again.');
    }

    // Success confirmation
    emailFormSection.classList.add('hidden');
    emailSuccessSection.classList.remove('hidden');

    if (result.simulated) {
      emailSuccessDesc.innerHTML = `
        <strong>Demo Mode:</strong> Photo saved to <code>sent_emails/${result.savedFilename || ''}</code>.<br>
        <span style="font-size: 0.88rem; color: #a3e635; display: inline-block; margin-top: 6px;">
          To receive real emails in your inbox, add your Google App Password to <code>.env</code>!
        </span>
      `;
    } else {
      emailSuccessDesc.innerHTML = `Your selfie was successfully delivered to <strong>${email}</strong> via ${result.provider || 'email'}! Check your inbox soon. 🐸🍋`;
    }
  } catch (err) {
    console.error('Send selfie error:', err);
    emailErrorBanner.textContent = `⚠️ Delivery error: ${err.message}. Please check your connection and try again.`;
    emailErrorBanner.classList.remove('hidden');

    btnSendEmail.disabled = false;
    btnSendEmail.innerHTML = '<span>TRY AGAIN</span>';
  }
});

// Success: TAKE ANOTHER SELFIE -> Return to camera
btnTakeAnother.addEventListener('click', () => {
  startCamera();
});

// Automatically start camera immediately on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    startCamera();
  });
} else {
  startCamera();
}
