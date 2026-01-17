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

  checkVideoStatus() {
    if (!this.videoElement) {
      this.vrLog("No video element!");
      return;
    }

    const status = {
      hasStream: !!this.videoElement.srcObject,
      paused: this.videoElement.paused,
      ended: this.videoElement.ended,
      readyState: this.videoElement.readyState,
      videoWidth: this.videoElement.videoWidth,
      videoHeight: this.videoElement.videoHeight,
      currentTime: this.videoElement.currentTime,
    };

    this.vrLog(`Video status: ${JSON.stringify(status)}`);
    console.log("Full video status:", status);

    if (this.videoElement.srcObject) {
      const tracks = this.videoElement.srcObject.getVideoTracks();
      this.vrLog(`Video tracks: ${tracks.length}`);
      tracks.forEach((track, i) => {
        this.vrLog(
          `Track ${i}: ${track.enabled ? "enabled" : "disabled"}, ${track.readyState}`,
        );
      });
    }
  }

  async requestVideoPlayPermission() {
    try {
      // Try to play with user gesture
      await this.videoElement.play();
      this.vrLog("Video play permission granted!");
      return true;
    } catch (err) {
      this.vrLog(`Video play blocked: ${err.name}`);

      // If it's a NotAllowedError, we need user interaction
      if (err.name === "NotAllowedError") {
        this.vrLog("Need user interaction - press trigger!");
        return false;
      }
      throw err;
    }
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

    document.body.appendChild(VRButton.createButton(this.renderer));

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
      1000,
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
      color: 0xff0000, // Start with RED so we can see it
      side: THREE.DoubleSide, // Visible from both sides
    });
    this.videoScreen = new THREE.Mesh(screenGeometry, screenMaterial);
    this.videoScreen.position.set(0, 2, -5); // Position in front of user
    this.scene.add(this.videoScreen);

    console.log("Video screen created at position:", this.videoScreen.position);
    this.vrLog(
      `Screen at: ${this.videoScreen.position.x}, ${this.videoScreen.position.y}, ${this.videoScreen.position.z}`,
    );

    // Add a wireframe box around the screen to make it easier to locate
    const wireframeGeometry = new THREE.EdgesGeometry(screenGeometry);
    const wireframeMaterial = new THREE.LineBasicMaterial({
      color: 0x00ff00,
      linewidth: 2,
    });
    const wireframe = new THREE.LineSegments(
      wireframeGeometry,
      wireframeMaterial,
    );
    this.videoScreen.add(wireframe);

    // Create hidden video element for WebRTC video stream
    this.videoElement = document.createElement("video");
    this.videoElement.id = "video-frame"; // Match what Go2WebRTC expects
    this.videoElement.style.display = "none";
    this.videoElement.autoplay = true;
    this.videoElement.muted = true;
    this.videoElement.playsInline = true; // Important for mobile/VR
    document.body.appendChild(this.videoElement);

    // Create hidden audio element for WebRTC audio stream (what the dog hears)
    this.audioElement = document.createElement("audio");
    this.audioElement.id = "audio-frame"; // Match what Go2WebRTC expects
    this.audioElement.style.display = "none";
    this.audioElement.autoplay = true;
    this.audioElement.muted = false; // NOT muted - we want to hear the audio!
    this.audioElement.volume = 1.0; // Full volume
    document.body.appendChild(this.audioElement);

    // Create video texture and apply to screen material
    this.setupVideoTexture();
  }

  setupVideoTexture() {
    if (this.videoElement) {
      this.videoTexture = new THREE.VideoTexture(this.videoElement);
      this.videoTexture.minFilter = THREE.LinearFilter;
      this.videoTexture.magFilter = THREE.LinearFilter;
      this.videoTexture.format = THREE.RGBAFormat;

      // Add event listeners to debug video state
      this.videoElement.addEventListener("loadedmetadata", () => {
        this.vrLog(
          `Video metadata: ${this.videoElement.videoWidth}x${this.videoElement.videoHeight}`,
        );

        // Switch to video texture and remove red tint
        this.videoScreen.material.map = this.videoTexture;
        this.videoScreen.material.color.set(0xffffff); // WHITE - remove red tint
        this.videoScreen.material.needsUpdate = true;
        this.videoTexture.needsUpdate = true;
        this.vrLog("Red tint removed!");
      });

      this.videoElement.addEventListener("loadeddata", () => {
        this.vrLog("Video data loaded!");

        // Switch to video texture as soon as we have data
        this.videoScreen.material.map = this.videoTexture;
        this.videoScreen.material.color.set(0xffffff); // WHITE - remove red tint
        this.videoScreen.material.needsUpdate = true;
        this.videoTexture.needsUpdate = true;
      });

      this.videoElement.addEventListener("playing", () => {
        this.vrLog("Video PLAYING!");

        // Make sure texture is applied and red tint is gone
        this.videoScreen.material.map = this.videoTexture;
        this.videoScreen.material.color.set(0xffffff); // WHITE - remove red tint
        this.videoScreen.material.needsUpdate = true;
        this.videoTexture.needsUpdate = true;
      });

      this.videoElement.addEventListener("canplay", () => {
        this.vrLog("Video can play!");

        // One more attempt to remove red tint
        this.videoScreen.material.map = this.videoTexture;
        this.videoScreen.material.color.set(0xffffff); // WHITE
        this.videoScreen.material.needsUpdate = true;
      });

      this.videoElement.addEventListener("error", (e) => {
        this.vrLog(`Video ERROR: ${e.message || "Unknown error"}`);
      });

      this.videoElement.addEventListener("stalled", () => {
        this.vrLog("Video stalled");
      });

      this.videoElement.addEventListener("waiting", () => {
        this.vrLog("Video waiting for data");
      });

      console.log("Video texture set up with event listeners");
      this.vrLog("Video element ready, waiting for stream...");
    }
  }
  createUIPanels() {
    // Create debug info panel with text
    const debugPanel = this.createTextPanel(
      "DEBUG LOG\n(waiting for events...)",
      -3,
      1.5,
      -3,
    );
    this.debugTextMesh = debugPanel.textMesh;
    this.uiPanels.push(debugPanel.panel);

    // Create connection status panel
    const statusPanel = this.createTextPanel(
      `STATUS\nRobot: 10.0.0.207\nConnection: Connecting...\nVersion: v${WEBXR_VERSION}`,
      3,
      1.5,
      -3,
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

      // If video is pending, try to play it
      if (this.videoElement && this.videoElement.srcObject) {
        if (this.videoElement.paused) {
          this.vrLog("Starting video playback...");
          this.videoElement
            .play()
            .then(() => {
              this.vrLog("Video playing!");
              this.pendingVideoStream = false;
            })
            .catch((err) => {
              this.vrLog(`Play error: ${err.name}`);
            });
        } else {
          this.vrLog("Video already playing");
        }
      } else {
        this.vrLog("Waiting for video stream...");
      }
    });

    // Monitor axes (joysticks) in animation loop
    this.lastJoystickValues = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
  }

  updateJoystickMovement() {
    const session = this.renderer.xr.getSession();
    if (!session) {
      return;
    }

    let leftStickX = 0,
      leftStickY = 0;
    let rightStickX = 0;
    let inputSourceCount = 0;

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

    // Map VR joysticks to robot movement (Matching index.js "Arcade" style)
    // Left Stick Y (Inverted): Forward/Backward (x)
    // Left Stick X (Inverted): Turn Left/Right (z)
    // Right Stick X (Inverted): Strafe Left/Right (y)

    const forward = -leftStickY; // x
    const turn = -leftStickX; // z (Turn)
    const strafe = -rightStickX; // y (Strafe)

    // Store previous values to detect changes
    if (!this.prevMovement) {
      this.prevMovement = { forward: 0, strafe: 0, turn: 0 };
    }

    // Check if there's any significant input OR if we need to send a stop command
    const hasInput =
      Math.abs(forward) > 0.01 ||
      Math.abs(strafe) > 0.01 ||
      Math.abs(turn) > 0.01;
    const hadInput =
      Math.abs(this.prevMovement.forward) > 0.01 ||
      Math.abs(this.prevMovement.strafe) > 0.01 ||
      Math.abs(this.prevMovement.turn) > 0.01;

    // Send command if:
    // 1. There's input now, OR
    // 2. There was input before but not now (send stop command)
    if (hasInput || hadInput) {
      // RATE LIMITING: Only send every 100ms to avoid spam
      const now = Date.now();
      if (now - this.lastMovementTime < 100) {
        return;
      }
      this.lastMovementTime = now;

      // Log if there's actual movement or if we're stopping
      if (hasInput) {
        this.vrLog(
          `Move: F${forward.toFixed(1)}, S${strafe.toFixed(1)}, T${turn.toFixed(1)}`,
        );
      } else if (hadInput && !hasInput) {
        this.vrLog("STOP");
      }

      this.sendMovement(forward, strafe, turn);

      // Store current values
      this.prevMovement = { forward, strafe, turn };
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
      JSON.stringify({ x: x, y: y, z: z }),
    );
  }

  async connectToRobot() {
    try {
      // Auto-connect to 10.0.0.207
      const robotIP = "10.0.0.207";
      const token = localStorage.getItem("token") || "";

      this.updateStatusPanel(
        `STATUS\nRobot: ${robotIP}\nConnection: Connecting...`,
      );

      console.log(`Auto-connecting to robot at ${robotIP}`);

      // Redirect Go2WebRTC logs to VR debug panel
      globalThis.logMessage = (msg) => {
        console.log("[Go2WebRTC]", msg);
        this.vrLog(`[RTC] ${msg}`);
      };

      this.vrLog("Initializing WebRTC...");
      const signalingServer = "10.0.0.43";
      this.rtc = new Go2WebRTC(token, robotIP, null, signalingServer);

      // Monitor track events directly
      this.rtc.pc.addEventListener("track", (event) => {
        this.vrLog(`Track event: ${event.track.kind}`);
        console.log("Track event received:", event);

        if (event.track.kind === "video") {
          this.vrLog("Video track received!");
          console.log("Video track details:", event.track);
          console.log("Video streams:", event.streams);

          // The go2webrtc.js should handle assigning srcObject
          // But we'll monitor to see if it happens
          setTimeout(() => {
            if (this.videoElement.srcObject) {
              this.vrLog("Video srcObject assigned by go2webrtc!");
              this.pendingVideoStream = true;
            } else {
              this.vrLog("No srcObject - assigning manually...");
              if (event.streams && event.streams[0]) {
                this.videoElement.srcObject = event.streams[0];
                this.pendingVideoStream = true;
              }
            }
          }, 100);
        } else if (event.track.kind === "audio") {
          this.vrLog("Audio track received! (What the dog hears)");
          console.log("Audio track details:", event.track);
          console.log("Audio streams:", event.streams);

          // The go2webrtc.js should handle assigning srcObject to audio element
          // But we'll monitor to see if it happens
          setTimeout(() => {
            if (this.audioElement.srcObject) {
              this.vrLog("Audio srcObject assigned by go2webrtc!");
              // Try to play the audio
              this.audioElement
                .play()
                .then(() => {
                  this.vrLog(
                    "Audio playing! You should hear what the dog hears.",
                  );
                })
                .catch((err) => {
                  this.vrLog(`Audio play failed: ${err.message}`);
                });
            } else {
              this.vrLog("No audio srcObject - assigning manually...");
              if (event.streams && event.streams[0]) {
                this.audioElement.srcObject = event.streams[0];
                // Try to play the audio
                this.audioElement
                  .play()
                  .then(() => {
                    this.vrLog(
                      "Audio playing! You should hear what the dog hears.",
                    );
                  })
                  .catch((err) => {
                    this.vrLog(`Audio play failed: ${err.message}`);
                  });
              }
            }
          }, 100);
        }
      });

      // Add ICE state monitoring with more detail
      this.rtc.pc.addEventListener("iceconnectionstatechange", () => {
        const state = this.rtc.pc.iceConnectionState;
        this.vrLog(`ICE State: ${state}`);
        console.log("ICE connection state changed:", state);

        if (state === "disconnected") {
          this.vrLog("ICE DISCONNECTED! Will retry...");
          // Don't panic - disconnected can recover
        } else if (state === "failed") {
          this.vrLog("ICE FAILED! Connection lost!");
        } else if (state === "connected") {
          this.vrLog("ICE CONNECTED!");
        } else if (state === "completed") {
          this.vrLog("ICE COMPLETED!");
        } else if (state === "checking") {
          this.vrLog("ICE Checking...");
        }

        this.updateStatusPanel(`STATUS\nRobot: ${robotIP}\nICE: ${state}`);
      });

      this.rtc.pc.addEventListener("icegatheringstatechange", () => {
        this.vrLog(`ICE Gathering: ${this.rtc.pc.iceGatheringState}`);
      });

      this.rtc.pc.addEventListener("signalingstatechange", () => {
        this.vrLog(`Signaling: ${this.rtc.pc.signalingState}`);
      });

      this.rtc.pc.addEventListener("connectionstatechange", () => {
        this.vrLog(`Connection: ${this.rtc.pc.connectionState}`);
      });

      // CRITICAL: Enable microphone BEFORE initSDP so it's included in the offer
      try {
        await this.rtc.enableMicrophone();
        this.vrLog("Microphone enabled");
      } catch (error) {
        console.log(
          "Microphone access denied, robot may not respond to movement commands",
        );
        this.vrLog("Mic denied - movement may not work");
      }

      // NOW create the SDP offer with the microphone track included
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

          if (state === "open") {
            if (!this.channelOpenLogged) {
              this.vrLog("Channel OPEN! Ready!");
              this.channelOpenLogged = true;

              // DON'T manually request video - let go2webrtc handle it via validation
              // The rtcValidation function in go2webrtc.js will send the "on" message
            }

            this.updateStatusPanel(
              `STATUS\nRobot: ${robotIP}\nConnection: Connected ✓\nICE: ${this.rtc.pc.iceConnectionState}`,
            );
            clearInterval(this.channelMonitor);
          } else if (state === "connecting") {
            // this.vrLog("Channel still connecting...");
          } else if (state === "closed") {
            this.vrLog("Channel CLOSED!");
          } else {
            this.vrLog(`Channel ${state}`);
          }
        } else {
          this.vrLog("No channel object yet");
        }
      };

      // Check channel state every 2 seconds
      monitorChannel(); // Check immediately
      this.channelMonitor = setInterval(monitorChannel, 2000);

      // Periodically check video status
      this.videoStatusChecker = setInterval(() => {
        this.checkVideoStatus();
      }, 10000); // Less frequent to reduce spam

      this.updateStatusPanel(
        `STATUS\nRobot: ${robotIP}\nConnection: Initializing...\nVersion: v${WEBXR_VERSION}`,
      );
      this.updateDebugPanel(
        "DEBUG INFO\nLeft Stick: Move/Strafe\nRight Stick: Rotate\nConnected: Yes",
      );

      console.log("Connected to robot in VR mode");
    } catch (error) {
      console.error("Failed to connect to robot:", error);
      this.vrLog(`Connect Error: ${error.message}`);
      this.updateStatusPanel(`STATUS\nRobot: ${robotIP}\nConnection: Failed ✗`);
    }
  }

  render(timestamp, frame) {
    if (!frame) return;

    // Check if we just entered VR mode and connect to robot
    if (this.renderer.xr.isPresenting && !this.isConnected && !this.rtc) {
      this.connectToRobot();
    }

    // Enable passthrough background in VR
    if (this.renderer.xr.isPresenting && this.scene.background !== null) {
      this.scene.background = null;
    }

    // Switch back to dark background when exiting VR
    if (!this.renderer.xr.isPresenting && this.scene.background === null) {
      this.scene.background = new THREE.Color(0x1f1f1f);
    }

    // Update video texture every frame when video is playing
    if (this.videoTexture && this.videoElement && this.videoElement.srcObject) {
      try {
        if (
          this.videoElement.readyState >= this.videoElement.HAVE_CURRENT_DATA
        ) {
          this.videoTexture.needsUpdate = true;

          // Debug log occasionally (every 120 frames)
          if (!this.videoUpdateCounter) this.videoUpdateCounter = 0;
          this.videoUpdateCounter++;
          if (this.videoUpdateCounter % 120 === 0) {
            this.vrLog(
              `Video updating: ${this.videoElement.videoWidth}x${this.videoElement.videoHeight}`,
            );
          }
        }
      } catch (err) {
        // Silently ignore texture update errors
        if (!this.videoErrorLogged) {
          this.vrLog(`Video texture error: ${err.message}`);
          this.videoErrorLogged = true;
        }
      }
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
