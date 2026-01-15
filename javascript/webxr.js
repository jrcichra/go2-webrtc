import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory.js";
import { Go2WebRTC } from "./go2webrtc.js";

// Version number for cache busting verification
const WEBXR_VERSION = 16;

class WebXRController {
  constructor() {
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.controllers = [];
    this.controllerGrips = [];
    this.videoScreen = null;
    this.uiPanels = [];
    this.debugTextMesh = null;
    this.statusTextMesh = null;
    this.rtc = null;
    this.isConnected = false;
    this.lastMovementTime = 0;
    this.debugLogs = []; // Store debug messages for VR panel
    this.maxDebugLogs = 10; // Keep last 10 messages

    this.init();
  }

  async init() {
    // Check if WebXR is supported
    if (!navigator.xr) {
      console.error("WebXR not supported");
      return;
    }

    // Check for VR support
    const isVRSupported = await navigator.xr.isSessionSupported("immersive-vr");
    if (!isVRSupported) {
      console.error("Immersive VR not supported");
      return;
    }

    // Initialize Three.js scene
    this.setupScene();

    // Add VR button (like vr-dungeon does)
    document.body.appendChild(VRButton.createButton(this.renderer));

    // Start render loop (like vr-dungeon does)
    this.renderer.setAnimationLoop((timestamp, frame) => {
      this.render(timestamp, frame);
    });

    console.log(`WebXR initialized - Version ${WEBXR_VERSION}`);
  }

  setupScene() {
    // Create scene
    this.scene = new THREE.Scene();
    // Start with dark background, will switch to passthrough when in VR
    this.scene.background = new THREE.Color(0x1f1f1f);

    // Create camera
    this.camera = new THREE.PerspectiveCamera(
      70,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    );

    // Create renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.xr.enabled = true;
    document.body.appendChild(this.renderer.domElement);

    // Add lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(0, 10, 5);
    this.scene.add(directionalLight);

    // Create large virtual screen for video feed
    this.createVideoScreen();

    // Create UI panels for debug info
    this.createUIPanels();

    // Setup controllers
    this.setupControllers();

    // No teleportation needed - user just wants to control robot from VR
  }

  createVideoScreen() {
    // Create a large virtual screen for video feed (like a big TV in VR)
    const screenGeometry = new THREE.PlaneGeometry(8, 4.5); // 16:9 aspect ratio
    const screenMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.8,
    });
    this.videoScreen = new THREE.Mesh(screenGeometry, screenMaterial);
    this.videoScreen.position.set(0, 2, -5); // Position in front of user
    this.scene.add(this.videoScreen);

    console.log("Video screen created");
  }

  createUIPanels() {
    // Create debug info panel with text
    const debugPanel = this.createTextPanel(
      "DEBUG LOG\n(waiting for events...)",
      -3,
      1.5,
      -3
    );
    this.debugTextMesh = debugPanel.textMesh;
    this.uiPanels.push(debugPanel.panel);

    // Create connection status panel
    const statusPanel = this.createTextPanel(
      `STATUS\nRobot: 10.0.0.207\nConnection: Connecting...\nVersion: v${WEBXR_VERSION}`,
      3,
      1.5,
      -3
    );
    this.statusTextMesh = statusPanel.textMesh;
    this.uiPanels.push(statusPanel.panel);
  }

  createTextPanel(text, x, y, z) {
    // Create canvas for text rendering
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    canvas.width = 512;
    canvas.height = 256;

    // Create texture from canvas
    const texture = new THREE.CanvasTexture(canvas);

    // Create panel geometry and material
    const panelGeometry = new THREE.PlaneGeometry(2, 1.5);
    const panelMaterial = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.9,
    });

    const panel = new THREE.Mesh(panelGeometry, panelMaterial);
    panel.position.set(x, y, z);
    panel.rotation.y = x > 0 ? -Math.PI * 0.1 : Math.PI * 0.1; // Slight angle

    this.scene.add(panel);

    // Create text mesh for updates
    const textMesh = {
      canvas: canvas,
      context: context,
      texture: texture,
      material: panelMaterial,
      updateText: (newText) => {
        this.renderTextToCanvas(context, canvas, newText);
        texture.needsUpdate = true;
      },
    };

    // Initial text render
    textMesh.updateText(text);

    return { panel, textMesh };
  }

  renderTextToCanvas(context, canvas, text) {
    // Clear canvas
    context.clearRect(0, 0, canvas.width, canvas.height);

    // Background
    context.fillStyle = "rgba(51, 51, 51, 0.9)";
    context.fillRect(0, 0, canvas.width, canvas.height);

    // Text settings
    context.fillStyle = "#ffffff";
    context.font = "bold 24px Arial";
    context.textAlign = "left";
    context.textBaseline = "top";

    // Draw text
    const lines = text.split("\n");
    let y = 20;
    lines.forEach((line) => {
      context.fillText(line, 20, y);
      y += 30;
    });

    // Border
    context.strokeStyle = "#666666";
    context.lineWidth = 2;
    context.strokeRect(5, 5, canvas.width - 10, canvas.height - 10);
  }

  setupControllers() {
    // Create controller objects
    for (let i = 0; i < 2; i++) {
      const controller = this.renderer.xr.getController(i);
      controller.addEventListener("connected", (event) => {
        this.onControllerConnected(event, i);
      });
      controller.addEventListener("disconnected", (event) => {
        this.onControllerDisconnected(event, i);
      });

      this.controllers.push(controller);
      this.scene.add(controller);
    }
  }

  onControllerConnected(event, index) {
    console.log(`Controller ${index} connected:`, event.data);

    // Get controller target and grip
    const controller = this.controllers[index];
    const controllerGrip = this.renderer.xr.getControllerGrip(index);

    // Load dynamic controller models that show button states
    const controllerModelFactory = new XRControllerModelFactory();
    const controllerModel =
      controllerModelFactory.createControllerModel(controllerGrip);
    controllerGrip.add(controllerModel);

    // Add grip to scene
    this.scene.add(controllerGrip);

    // Setup joystick input handling
    this.setupJoystickInput(index);
  }

  onControllerDisconnected(event, index) {
    console.log(`Controller ${index} disconnected`);
  }

  setupJoystickInput(controllerIndex) {
    const controller = this.controllers[controllerIndex];

    // Listen for controller input
    controller.addEventListener("selectstart", () => {
      console.log(`Controller ${controllerIndex} trigger pressed`);
    });

    // Monitor axes (joysticks) in animation loop
    this.lastJoystickValues = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
  }

  updateJoystickMovement() {
    if (!this.isConnected || !this.rtc) {
      this.vrLog("Joystick: Not connected");
      return;
    }

    // Get WebXR input sources (like vr-dungeon does)
    const session = this.renderer.xr.getSession();
    if (!session) {
      this.vrLog("Joystick: No session");
      return;
    }

    let leftStickX = 0,
      leftStickY = 0;
    let rightStickX = 0;
    let inputSourceCount = 0;

    // Process input sources exactly like vr-dungeon
    for (const source of session.inputSources) {
      inputSourceCount++;
      if (source.gamepad) {
        const gamepad = source.gamepad;
        const deadzone = 0.15;

        if (source.handedness === "left") {
          // Quest 2 uses axes[2] and axes[3] for left thumbstick
          if (gamepad.axes.length > 3) {
            const x2 = gamepad.axes[2] || 0;
            const y3 = gamepad.axes[3] || 0;
            if (Math.abs(x2) > deadzone || Math.abs(y3) > deadzone) {
              leftStickX = x2;
              leftStickY = y3;
            }
          }

          // Fallback to axes[0] and axes[1] if extended axes didn't work
          if (leftStickX === 0 && leftStickY === 0 && gamepad.axes.length > 1) {
            const x0 = gamepad.axes[0] || 0;
            const y1 = gamepad.axes[1] || 0;
            if (Math.abs(x0) > deadzone || Math.abs(y1) > deadzone) {
              leftStickX = x0;
              leftStickY = y1;
            }
          }
        }

        if (source.handedness === "right") {
          // Quest 2 uses axes[2] for right thumbstick X-axis
          if (gamepad.axes.length > 3) {
            const x2 = gamepad.axes[2] || 0;
            if (Math.abs(x2) > deadzone) {
              rightStickX = x2;
            }
          }

          // Fallback to axes[0] if extended axes didn't work
          if (rightStickX === 0 && gamepad.axes.length > 1) {
            const x0 = gamepad.axes[0] || 0;
            if (Math.abs(x0) > deadzone) {
              rightStickX = x0;
            }
          }
        }
      }
    }

    // DEBUG: Log raw values for first controller occasionally
    if (!this.axisLogCounter) this.axisLogCounter = 0;
    this.axisLogCounter++;
    if (
      this.axisLogCounter % 120 === 0 &&
      session.inputSources[0] &&
      session.inputSources[0].gamepad
    ) {
      const gp = session.inputSources[0].gamepad;
      // Log all axes to see which ones move
      const axesStr = gp.axes.map((a) => a.toFixed(2)).join(",");
      this.updateDebugPanel(`Axes Debug:\n[${axesStr}]`);
    }

    // Log controller status periodically (every 60 frames)
    if (!this.joystickLogCounter) this.joystickLogCounter = 0;
    this.joystickLogCounter++;
    if (this.joystickLogCounter % 60 === 0) {
      this.vrLog(`Controllers: ${inputSourceCount} detected`);
      if (inputSourceCount === 0) {
        this.vrLog("WARNING: No controllers!");
      }
    }

    // Only send movement if there's significant input
    if (
      Math.abs(leftStickX) > 0.1 ||
      Math.abs(leftStickY) > 0.1 ||
      Math.abs(rightStickX) > 0.1
    ) {
      // RATE LIMITING: Only send every 100ms to match desktop behavior
      const now = Date.now();
      if (now - this.lastMovementTime < 100) {
        return;
      }
      this.lastMovementTime = now;

      // Map VR joysticks to robot movement (Matching index.js "Arcade" style)
      // Left Stick Y (Inverted): Forward/Backward (x)
      // Left Stick X (Inverted): Turn Left/Right (z)
      // Right Stick X (Inverted): Strafe Left/Right (y)

      // Scale to matching index.js magnitude (~2.0 max)
      const forward = -leftStickY * 2.0; // x
      const turn = -leftStickX * 2.0; // z (Turn) - Note: index.js uses Left Stick X for Z
      const strafe = -rightStickX * 1.5; // y (Strafe) - Note: index.js uses Right Stick X for Y

      this.vrLog(
        `Move: F${forward.toFixed(1)}, S${strafe.toFixed(1)}, T${turn.toFixed(
          1
        )}`
      );
      this.sendMovement(forward, strafe, turn);
    }
  }

  sendMovement(x, y, z) {
    if (!this.rtc) {
      this.vrLog("Move failed: No RTC");
      return;
    }

    // Check data channel state
    if (!this.rtc.channel) {
      this.vrLog("Move failed: No channel");
      return;
    }

    const channelState = this.rtc.channel.readyState;
    if (channelState !== "open") {
      this.vrLog(`Channel state: ${channelState}`);
      return;
    }

    console.log("VR Movement:", { x, y, z });

    this.rtc.publishApi(
      "rt/api/sport/request",
      1008, // Move command
      JSON.stringify({ x: x, y: y, z: z })
    );
  }

  async connectToRobot() {
    try {
      // Auto-connect to 10.0.0.207
      const robotIP = "10.0.0.207";
      const token = localStorage.getItem("token") || "";

      this.updateStatusPanel(
        `STATUS\nRobot: ${robotIP}\nConnection: Connecting...`
      );

      console.log(`Auto-connecting to robot at ${robotIP}`);

      // Redirect Go2WebRTC logs to VR debug panel
      globalThis.logMessage = (msg) => {
        console.log("[Go2WebRTC]", msg);
        this.vrLog(`[RTC] ${msg}`);
      };

      // CRITICAL: Create video element BEFORE WebRTC connection
      // The go2webrtc.js validation callback checks for this element
      // and only sends the video "on" message if it exists
      this.ensureVideoElement();

      this.vrLog("Initializing WebRTC...");
      // CRITICAL: Connect to SIGNALING server at computer IP (10.0.0.43)
      // but target ROBOT at robot IP (10.0.0.207)
      const signalingServer = "10.0.0.43";
      this.rtc = new Go2WebRTC(token, robotIP, null, signalingServer);

      // Add ICE state monitoring
      this.rtc.pc.addEventListener("iceconnectionstatechange", () => {
        this.vrLog(`ICE State: ${this.rtc.pc.iceConnectionState}`);
        this.updateStatusPanel(
          `STATUS\nRobot: ${robotIP}\nICE: ${this.rtc.pc.iceConnectionState}`
        );
      });

      this.rtc.pc.addEventListener("icegatheringstatechange", () => {
        this.vrLog(`ICE Gathering: ${this.rtc.pc.iceGatheringState}`);
      });

      this.rtc.pc.addEventListener("signalingstatechange", () => {
        this.vrLog(`Signaling: ${this.rtc.pc.signalingState}`);
      });

      // Skip microphone for now as requested by user
      // try {
      //   await this.rtc.enableMicrophone();
      // } catch (error) {
      //   console.log("Microphone access denied, connecting without audio");
      // }

      try {
        await this.rtc.initSDP();
        this.isConnected = true;
        this.vrLog("WebRTC connected!");
      } catch (sdpError) {
        this.vrLog(`SDP Error: ${sdpError.message}`);
        console.error("SDP Init Error:", sdpError);
        throw sdpError;
      }

      // Monitor data channel state
      const monitorChannel = () => {
        if (this.rtc && this.rtc.channel) {
          const state = this.rtc.channel.readyState;
          // this.vrLog(`Data channel: ${state}`); // Too spammy if logged every 2s

          if (state === "open") {
            this.vrLog("Channel OPEN! Ready!");
            this.updateStatusPanel(
              `STATUS\nRobot: ${robotIP}\nConnection: Connected ✓\nICE: ${this.rtc.pc.iceConnectionState}`
            );
            clearInterval(this.channelMonitor);
          } else if (state === "connecting") {
            // this.vrLog("Channel still connecting...");
          } else {
            this.vrLog(`Channel ${state} (not open)`);
          }
        } else {
          this.vrLog("No channel object yet");
        }
      };

      // Check channel state every 2 seconds
      monitorChannel(); // Check immediately
      this.channelMonitor = setInterval(monitorChannel, 2000);

      // Wait a bit for validation to complete, then manually enable video
      setTimeout(() => {
        console.log("Manually enabling video and audio streams for VR");
        // Manually send video "on" message in case validation missed it
        if (this.rtc.channel && this.rtc.channel.readyState === "open") {
          this.rtc.publish("", "on", 1); // DataChannelType.VID = 1
        } else {
          this.vrLog("Cannot send VID: Channel not open");
        }
        // Skip audio for now
        // this.rtc.publish("", "on", 2); // DataChannelType.AUD = 2
      }, 1000);

      // Set up video feed on VR screen
      this.setupVideoTexture();

      this.updateStatusPanel(
        `STATUS\nRobot: ${robotIP}\nConnection: Initializing...\nVersion: v${WEBXR_VERSION}`
      );
      this.updateDebugPanel(
        "DEBUG INFO\nLeft Stick: Move/Strafe\nRight Stick: Rotate\nConnected: Yes"
      );

      console.log("Connected to robot in VR mode");
    } catch (error) {
      console.error("Failed to connect to robot:", error);
      this.vrLog(`Connect Error: ${error.message}`);
      this.updateStatusPanel(`STATUS\nRobot: ${robotIP}\nConnection: Failed ✗`);
    }
  }

  ensureVideoElement() {
    // Create video element if it doesn't exist
    // This MUST exist before WebRTC validation happens
    let videoElement = document.getElementById("video-frame");
    if (!videoElement) {
      console.log("Creating video-frame element for VR");
      videoElement = document.createElement("video");
      videoElement.id = "video-frame";
      videoElement.autoplay = true;
      videoElement.muted = true;
      videoElement.playsInline = true;
      videoElement.style.display = "none";
      document.body.appendChild(videoElement);
    }
    return videoElement;
  }

  render(timestamp, frame) {
    if (!frame) return;

    // Check if we just entered VR mode and connect to robot
    if (this.renderer.xr.isPresenting && !this.isConnected && !this.rtc) {
      this.connectToRobot();
      // Enable passthrough background in VR
      this.scene.background = null;
    }

    // Switch back to dark background when exiting VR
    if (!this.renderer.xr.isPresenting && this.scene.background === null) {
      this.scene.background = new THREE.Color(0x1f1f1f);
    }

    // CRITICAL: Ensure video is playing and texture updates
    const videoElement = document.getElementById("video-frame");
    if (videoElement) {
      if (videoElement.paused) {
        videoElement.play().catch((e) => {}); // Force play if paused
      }
    }
    if (this.videoTexture) {
      this.videoTexture.needsUpdate = true;
    }

    // Update joystick input
    this.updateJoystickMovement();

    // Render the scene
    this.renderer.render(this.scene, this.camera);
  }

  // Method to update debug info on VR panels
  updateDebugInfo(info) {
    // This could update text textures on the VR panels
    console.log("VR Debug:", info);
  }

  updateDebugPanel(text) {
    if (this.debugTextMesh) {
      this.debugTextMesh.updateText(text);
    }
  }

  // Add a VR-visible debug log message
  vrLog(message) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `${timestamp.slice(-8)}: ${message}`;

    console.log(`[VR] ${logEntry}`);

    // Add to debug logs array
    this.debugLogs.push(logEntry);

    // Keep only last N messages
    if (this.debugLogs.length > this.maxDebugLogs) {
      this.debugLogs.shift();
    }

    // Update debug panel with scrolling logs
    const debugText = "DEBUG LOG\n" + this.debugLogs.join("\n");
    this.updateDebugPanel(debugText);
  }

  setupVideoTexture() {
    if (!this.rtc || !this.videoScreen) return;

    // Wait for video track to be available
    const checkForVideo = () => {
      if (
        this.rtc.VidTrackEvent &&
        this.rtc.VidTrackEvent.streams &&
        this.rtc.VidTrackEvent.streams[0]
      ) {
        const videoStream = this.rtc.VidTrackEvent.streams[0];

        // Get video element (should already exist from ensureVideoElement)
        const videoElement = document.getElementById("video-frame");
        if (!videoElement) {
          console.error("Video element not found! This should not happen.");
          return;
        }

        // Set video stream
        videoElement.srcObject = videoStream;

        // Wait for video to actually start playing before creating texture
        const onVideoPlaying = () => {
          console.log("Video playing, creating VR texture");

          // Create video texture for VR screen with proper format
          const videoTexture = new THREE.VideoTexture(videoElement);
          videoTexture.minFilter = THREE.LinearFilter;
          videoTexture.magFilter = THREE.LinearFilter;
          videoTexture.format = THREE.RGBAFormat; // Use RGBA for video
          videoTexture.colorSpace = THREE.SRGBColorSpace;

          // Update the video screen material to show the video
          this.videoScreen.material = new THREE.MeshBasicMaterial({
            map: videoTexture,
            transparent: false,
          });

          // Store texture reference for updates
          this.videoTexture = videoTexture;

          console.log("Video texture set up on VR screen");
        };

        // Listen for playing event
        videoElement.addEventListener("playing", onVideoPlaying, {
          once: true,
        });

        // Force play in case autoplay doesn't trigger
        videoElement.play().catch((e) => {
          console.log("Video play failed, will retry:", e);
          setTimeout(() => videoElement.play(), 500);
        });
      } else {
        // Retry after a short delay
        setTimeout(checkForVideo, 500);
      }
    };

    checkForVideo();
  }

  updateStatusPanel(text) {
    if (this.statusTextMesh) {
      this.statusTextMesh.updateText(text);
    }
  }
}

// Initialize WebXR when the script loads
document.addEventListener("DOMContentLoaded", () => {
  const webxr = new WebXRController();
});

export { WebXRController };
