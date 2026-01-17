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
    this.robotState = {};
    this.lastStateUpdate = 0;
    this.debugLogs = [];
    this.maxDebugLogs = 10;

    // Menu system properties
    this.menuVisible = false;
    this.selectedMenuItem = -1;
    this.currentCategory = null;
    this.lastButtonStates = {
      leftMenu: false,
      rightMenu: false,
      leftTrigger: false,
      rightTrigger: false,
    };

    // Movement speed multiplier (0.0 to 1.0)
    this.movementSpeed = 0.4;

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

    // Create menu (but keep it hidden)
    this.createCommandMenu();
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
    // Left panel: Debug log
    const debugPanel = this.createTextPanel(
      "DEBUG LOG\n(waiting for events...)",
      -3.5,
      1.5,
      -3,
    );
    this.debugTextMesh = debugPanel.textMesh;
    this.uiPanels.push(debugPanel.panel);

    // Right panel: Status
    const statusPanel = this.createTextPanel(
      `STATUS\nRobot: 10.0.0.207\nConnection: Connecting...\nSpeed: ${Math.round(this.movementSpeed * 100)}%\nMenu: Press Y/B`,
      3.5,
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

    // Add laser pointer to controller (only for right hand)
    if (index === 1) {
      // Right controller
      this.laserPointer = this.createLaserPointer(controller);
    }

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

    // Map VR joysticks to robot movement (Swapped controls)
    // Left Stick Y (Inverted): Forward/Backward (x)
    // Left Stick X (Inverted): Strafe Left/Right (y)
    // Right Stick X (Inverted): Turn Left/Right (z)

    const forward = -leftStickY * this.movementSpeed; // x
    const strafe = -leftStickX * this.movementSpeed; // y (Strafe)
    const turn = -rightStickX * this.movementSpeed; // z (Turn)

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

      // Start requesting robot state for HUD
      this.startStateUpdates();

      this.updateStatusPanel(
        `STATUS\nRobot: ${robotIP}\nConnection: Initializing...\nVersion: v${WEBXR_VERSION}`,
      );
      this.updateDebugPanel(
        "DEBUG INFO\nLeft Stick: Strafe/Move\nRight Stick: Turn\nConnected: Yes",
      );

      console.log("Connected to robot in VR mode");
    } catch (error) {
      console.error("Failed to connect to robot:", error);
      this.vrLog(`Connect Error: ${error.message}`);
      this.updateStatusPanel(`STATUS\nRobot: ${robotIP}\nConnection: Failed ✗`);
    }
  }

  createLaserPointer(controller) {
    // Create laser line geometry
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array([0, 0, 0, 0, 0, -5]); // 5 meter ray
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

    const material = new THREE.LineBasicMaterial({
      color: 0x00ff00,
      linewidth: 2,
      opacity: 0.8,
      transparent: true,
    });

    const laser = new THREE.Line(geometry, material);
    laser.visible = false; // Start hidden
    controller.add(laser);

    return laser;
  }

  render(timestamp, frame) {
    if (!frame) return;

    if (this.renderer.xr.isPresenting && !this.isConnected && !this.rtc) {
      this.connectToRobot();
    }

    if (this.renderer.xr.isPresenting && this.scene.background !== null) {
      this.scene.background = null;
    }

    if (!this.renderer.xr.isPresenting && this.scene.background === null) {
      this.scene.background = new THREE.Color(0x1f1f1f);
    }

    // Update video texture
    if (this.videoTexture && this.videoElement && this.videoElement.srcObject) {
      try {
        if (
          this.videoElement.readyState >= this.videoElement.HAVE_CURRENT_DATA
        ) {
          this.videoTexture.needsUpdate = true;
        }
      } catch (err) {
        if (!this.videoErrorLogged) {
          this.vrLog(`Video texture error: ${err.message}`);
          this.videoErrorLogged = true;
        }
      }
    }

    // Update joystick input
    this.updateJoystickMovement();

    // Update menu buttons and raycasting
    this.updateMenuButtons();
    if (this.menuVisible) {
      this.updateMenuRaycasting();
    }

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

  // Start periodic robot state updates for HUD
  startStateUpdates() {
    // Request state every 2 seconds
    this.stateUpdateInterval = setInterval(() => {
      this.requestRobotState();
    }, 2000);

    // Also listen for state messages from the robot
    this.setupStateMessageHandler();
  }

  // Request robot state information
  requestRobotState() {
    if (
      !this.rtc ||
      !this.rtc.channel ||
      this.rtc.channel.readyState !== "open"
    ) {
      return;
    }

    // Request GetState (command 1034)
    this.rtc.publishApi("rt/api/sport/request", 1034, "");
  }

  // Setup handler for incoming state messages
  setupStateMessageHandler() {
    if (!this.rtc) return;

    // Override the message callback to intercept state messages
    const originalCallback = this.rtc.messageCallback;
    this.rtc.messageCallback = (data) => {
      // Handle state messages for HUD
      if (data && data.topic) {
        if (
          data.topic.includes("sportmodestate") ||
          data.topic.includes("servicestate")
        ) {
          this.handleStateMessage(data);
        }
      }

      // Call original callback if it exists
      if (originalCallback) {
        originalCallback(data);
      }
    };
  }

  // Handle incoming state messages and update HUD
  handleStateMessage(data) {
    try {
      console.log("State message received:", data);

      // Update robot state data
      if (data.data) {
        this.robotState = { ...this.robotState, ...data.data };
        this.lastStateUpdate = Date.now();

        // Update HUD panels with new data
        this.updateHUDPanels();
      }
    } catch (error) {
      console.error("Error handling state message:", error);
    }
  }

  // Update all HUD panels with current robot state
  updateHUDPanels() {
    this.updateMovementHUD();
    this.updateBatterySensorsHUD();
    this.updateRobotStateHUD();
  }

  // Update movement/control HUD
  updateMovementHUD() {
    const velocity = this.robotState.velocity || "--";
    const mode = this.robotState.mode || "Manual";
    const gait = this.robotState.gait || "Walk";

    const hudText = `MOVEMENT HUD\nVelocity: ${velocity}\nMode: ${mode}\nGait: ${gait}`;

    if (this.hudTextMesh) {
      this.hudTextMesh.updateText(hudText);
    }
  }

  // Update battery and sensors HUD
  updateBatterySensorsHUD() {
    const battery = this.robotState.battery || "--";
    const temperature = this.robotState.temperature || "--";
    const lidar = this.robotState.lidar ? "ON" : "--";
    const cameras = this.robotState.cameras ? "ON" : "--";

    const batteryText = `BATTERY & SENSORS\nBattery: ${battery}%\nTemp: ${temperature}°C\nLidar: ${lidar}\nCameras: ${cameras}`;

    if (this.batteryTextMesh) {
      this.batteryTextMesh.updateText(batteryText);
    }
  }

  // Update robot state/orientation HUD
  updateRobotStateHUD() {
    const roll = this.robotState.roll ? this.robotState.roll.toFixed(1) : "--";
    const pitch = this.robotState.pitch
      ? this.robotState.pitch.toFixed(1)
      : "--";
    const yaw = this.robotState.yaw ? this.robotState.yaw.toFixed(1) : "--";
    const obstacles = this.robotState.obstacleDistance
      ? this.robotState.obstacleDistance.toFixed(1)
      : "--";

    const sensorsText = `ROBOT STATE\nRoll: ${roll}°\nPitch: ${pitch}°\nYaw: ${yaw}°\nObstacles: ${obstacles}m`;

    if (this.sensorsTextMesh) {
      this.sensorsTextMesh.updateText(sensorsText);
    }
  }

  // Stop state updates when disconnecting
  stopStateUpdates() {
    if (this.stateUpdateInterval) {
      clearInterval(this.stateUpdateInterval);
      this.stateUpdateInterval = null;
    }
  }

  updateMenuButtons() {
    if (!this.renderer.xr.isPresenting) return;

    const session = this.renderer.xr.getSession();
    if (!session) return;

    for (const source of session.inputSources) {
      if (!source.gamepad) continue;

      const gamepad = source.gamepad;
      const handedness = source.handedness;

      // Button 4 = Y/B button on Quest controllers
      const menuButton = gamepad.buttons[4];
      const menuPressed = menuButton && menuButton.pressed;

      // Button 0 = trigger
      const triggerButton = gamepad.buttons[0];
      const triggerPressed = triggerButton && triggerButton.pressed;

      // Check for menu button press (detect rising edge)
      if (handedness === "left") {
        if (menuPressed && !this.lastButtonStates.leftMenu) {
          this.toggleMenu();
        }
        this.lastButtonStates.leftMenu = menuPressed;

        if (triggerPressed && !this.lastButtonStates.leftTrigger) {
          this.handleMenuSelection();
        }
        this.lastButtonStates.leftTrigger = triggerPressed;
      }

      if (handedness === "right") {
        if (menuPressed && !this.lastButtonStates.rightMenu) {
          this.toggleMenu();
        }
        this.lastButtonStates.rightMenu = menuPressed;

        if (triggerPressed && !this.lastButtonStates.rightTrigger) {
          this.handleMenuSelection();
        }
        this.lastButtonStates.rightTrigger = triggerPressed;
      }
    }
  }

  toggleMenu() {
    if (this.menuVisible) {
      this.hideMenu();
    } else {
      this.showMenu();
    }
  }

  showMenu() {
    this.menuVisible = true;

    if (this.menuGroup) {
      this.menuGroup.visible = true;
    }

    // Show laser pointer
    if (this.laserPointer) {
      this.laserPointer.visible = true;
    }

    // Reset to category view
    this.hideCommandButtons();
    this.currentCategory = null;
    this.menuTitleTextMesh.updateText("ROBOT COMMANDS - Select Category");

    this.vrLog("Menu opened");
  }

  hideMenu() {
    this.menuVisible = false;

    if (this.menuGroup) {
      this.menuGroup.visible = false;
    }

    // Hide laser pointer
    if (this.laserPointer) {
      this.laserPointer.visible = false;
    }

    this.hideCommandButtons();
    this.currentCategory = null;
    this.selectedMenuItem = -1;
    this.selectedButton = null;

    this.vrLog("Menu closed");
  }

  updateMenuRaycasting() {
    if (!this.menuVisible || !this.renderer.xr.isPresenting) return;

    // Use controller 1 (right hand) for raycasting
    const controller = this.controllers[1];
    if (!controller) return;

    // Create raycaster from controller position
    const raycaster = new THREE.Raycaster();
    const tempMatrix = new THREE.Matrix4();

    // Set raycaster from controller
    tempMatrix.identity().extractRotation(controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

    // Get all interactive menu objects
    const interactiveObjects = [];

    if (this.categoryButtons) {
      this.categoryButtons.forEach((b) => {
        if (b.panel.visible) interactiveObjects.push(b.panel);
      });
    }

    if (this.commandButtons) {
      this.commandButtons.forEach((b) => {
        if (b.panel.visible) interactiveObjects.push(b.panel);
      });
    }

    // Clear previous selection - hide all wireframes
    if (this.categoryButtons) {
      this.categoryButtons.forEach((b) => {
        if (b.wireframe) b.wireframe.visible = false;
      });
    }
    if (this.commandButtons) {
      this.commandButtons.forEach((b) => {
        if (b.wireframe) b.wireframe.visible = false;
      });
    }

    // Find intersections
    const intersects = raycaster.intersectObjects(interactiveObjects);

    // Highlight selected object
    if (intersects.length > 0) {
      const selectedObject = intersects[0].object;

      // Find the button that owns this panel
      let selectedButton = null;

      if (this.categoryButtons) {
        selectedButton = this.categoryButtons.find(
          (b) => b.panel === selectedObject,
        );
      }

      if (!selectedButton && this.commandButtons) {
        selectedButton = this.commandButtons.find(
          (b) => b.panel === selectedObject,
        );
      }

      if (selectedButton && selectedButton.wireframe) {
        selectedButton.wireframe.visible = true;
        this.selectedButton = selectedButton;
      }
    } else {
      this.selectedButton = null;
    }
  }

  handleMenuSelection() {
    if (!this.selectedButton) return;

    if (this.selectedButton.panel.userData.onClick) {
      this.selectedButton.panel.userData.onClick();
    }
  }

  createCommandMenu() {
    // Define robot commands organized by category
    this.robotCommands = {
      basic: [
        { id: 1004, name: "Stand Up", desc: "Stand on all fours" },
        { id: 1005, name: "Lie Down", desc: "Lie down flat" },
        { id: 1009, name: "Sit", desc: "Sit position" },
        { id: 1003, name: "Stop", desc: "Stop all movement" },
        { id: 1001, name: "Damp Mode", desc: "Soft/relaxed" },
        { id: 1002, name: "Balance", desc: "Balance stand" },
      ],
      tricks: [
        { id: 1016, name: "Hello", desc: "Wave hello" },
        { id: 1017, name: "Stretch", desc: "Stretch body" },
        { id: 1030, name: "Front Flip", desc: "Do a flip" },
        { id: 1031, name: "Jump", desc: "Jump forward" },
        { id: 1032, name: "Pounce", desc: "Pounce attack" },
        { id: 1022, name: "Dance 1", desc: "Dance routine 1" },
        { id: 1023, name: "Dance 2", desc: "Dance routine 2" },
        { id: 1029, name: "Scrape", desc: "Scrape ground" },
      ],
      movement: [
        { id: 1011, name: "Switch Gait", desc: "Change walk style" },
        { id: 1015, name: "Speed Level", desc: "Adjust speed" },
        { id: 1035, name: "Eco Mode", desc: "Energy saving" },
      ],
    };

    // Create menu background panel
    this.createMenuBackground();

    // Create menu category buttons
    this.createMenuCategories();

    // IMPORTANT: Start hidden
    this.hideMenu();
    this.vrLog("Menu created (hidden)");
  }

  createMenuBackground() {
    // Create a group to hold all menu elements
    this.menuGroup = new THREE.Group();
    this.menuGroup.position.set(0, 0, -2.5); // Position in front of camera

    // Large semi-transparent background panel for menu
    const bgGeometry = new THREE.PlaneGeometry(5, 3.5);
    const bgMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.85,
    });
    this.menuBackground = new THREE.Mesh(bgGeometry, bgMaterial);
    this.menuBackground.position.set(0, 0, 0);

    // Add border
    const borderGeometry = new THREE.EdgesGeometry(bgGeometry);
    const borderMaterial = new THREE.LineBasicMaterial({
      color: 0x00ff00,
      linewidth: 2,
    });
    const border = new THREE.LineSegments(borderGeometry, borderMaterial);
    this.menuBackground.add(border);

    this.menuGroup.add(this.menuBackground);

    // Menu title
    const titleCanvas = document.createElement("canvas");
    const titleContext = titleCanvas.getContext("2d");
    titleCanvas.width = 512;
    titleCanvas.height = 128;

    const titleTexture = new THREE.CanvasTexture(titleCanvas);
    const titleGeometry = new THREE.PlaneGeometry(4, 0.6);
    const titleMaterial = new THREE.MeshBasicMaterial({
      map: titleTexture,
      transparent: true,
    });

    this.menuTitlePanel = new THREE.Mesh(titleGeometry, titleMaterial);
    this.menuTitlePanel.position.set(0, 1.5, 0); // Relative to menuGroup
    this.menuGroup.add(this.menuTitlePanel);

    this.menuTitleTextMesh = {
      canvas: titleCanvas,
      context: titleContext,
      texture: titleTexture,
      updateText: (text) => {
        this.renderMenuText(titleContext, titleCanvas, text);
        titleTexture.needsUpdate = true;
      },
    };

    this.menuTitleTextMesh.updateText("ROBOT COMMANDS");

    // Add menu group to camera so it follows head movement
    this.camera.add(this.menuGroup);
    this.scene.add(this.camera); // Make sure camera is in scene

    // Start hidden
    this.menuGroup.visible = false;
  }

  renderMenuText(context, canvas, text) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#00ff00";
    context.font = "bold 40px Arial";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, canvas.width / 2, canvas.height / 2);
  }

  createMenuCategories() {
    const categories = [
      { name: "Basic", key: "basic", x: -1.5, color: 0x4caf50 },
      { name: "Tricks", key: "tricks", x: 0, color: 0xff9800 },
      { name: "Movement", key: "movement", x: 1.5, color: 0x2196f3 },
    ];

    this.categoryButtons = [];

    categories.forEach((cat, index) => {
      const button = this.createMenuButton(
        cat.name,
        cat.x,
        0.5, // Relative to menuGroup
        0.01, // Just in front of background
        cat.color,
        () => this.showCategory(cat.key),
      );
      this.categoryButtons.push(button);
      this.menuGroup.add(button.panel); // Add to menuGroup instead of scene
    });
  }

  createMenuButton(text, x, y, z, color, onClick) {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    canvas.width = 256;
    canvas.height = 128;

    const texture = new THREE.CanvasTexture(canvas);
    const buttonGeometry = new THREE.PlaneGeometry(1.8, 0.7);
    const buttonMaterial = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
    });

    const button = new THREE.Mesh(buttonGeometry, buttonMaterial);
    button.position.set(x, y, z);
    button.userData = { onClick, type: "button", color };

    // Add wireframe for selection highlight
    const wireframeGeometry = new THREE.EdgesGeometry(buttonGeometry);
    const wireframeMaterial = new THREE.LineBasicMaterial({
      color: 0xffff00,
      linewidth: 3,
    });
    const wireframe = new THREE.LineSegments(
      wireframeGeometry,
      wireframeMaterial,
    );
    wireframe.visible = false;
    button.add(wireframe);
    button.userData.wireframe = wireframe;

    // DON'T add to scene here - caller will add to menuGroup

    const textMesh = {
      canvas,
      context,
      texture,
      updateText: (newText) => {
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
        context.fillRect(0, 0, canvas.width, canvas.height);

        context.fillStyle = "#ffffff";
        context.font = "bold 20px Arial";
        context.textAlign = "center";
        context.textBaseline = "middle";

        const lines = newText.split("\n");
        lines.forEach((line, i) => {
          context.fillText(
            line,
            canvas.width / 2,
            canvas.height / 2 + (i - 0.5) * 25,
          );
        });

        texture.needsUpdate = true;
      },
    };

    textMesh.updateText(text);

    return { panel: button, textMesh, wireframe };
  }

  showCategory(categoryKey) {
    // Hide existing command buttons
    this.hideCommandButtons();

    const commands = this.robotCommands[categoryKey];
    if (!commands) return;

    this.currentCategory = categoryKey;
    this.commandButtons = [];

    commands.forEach((cmd, index) => {
      const col = index % 2;
      const row = Math.floor(index / 2);
      const x = col * 2.2 - 1.1;
      const y = 0.5 - row * 0.9;

      const button = this.createMenuButton(
        `${cmd.name}\n${cmd.desc}`,
        x,
        y,
        0.01,
        0x555555,
        () => this.sendCommand(cmd.id, cmd.name),
      );
      this.commandButtons.push(button);
      this.menuGroup.add(button.panel);
    });

    // Add a "Back" button
    const backButton = this.createMenuButton(
      "← BACK",
      0,
      -1.2,
      0.01,
      0xff5722,
      () => {
        this.hideCommandButtons();
        this.currentCategory = null;
        this.menuTitleTextMesh.updateText("ROBOT COMMANDS - Select Category");
      },
    );
    this.commandButtons.push(backButton);
    this.menuGroup.add(backButton.panel);

    this.menuTitleTextMesh.updateText(`${categoryKey.toUpperCase()} COMMANDS`);
  }

  hideCommandButtons() {
    if (this.commandButtons) {
      this.commandButtons.forEach((button) => {
        this.menuGroup.remove(button.panel); // Remove from menuGroup
      });
      this.commandButtons = [];
    }
  }

  addNavigationButtons(totalCommands) {
    this.navButtons = [];
    const totalPages = Math.ceil(totalCommands / this.menuItemsPerPage);

    if (this.menuPage > 0) {
      const prevButton = this.createMenuButton(
        "Previous\nPage",
        -2.5,
        -0.5,
        -1.9,
        0xff5722,
        () => {
          this.menuPage--;
          this.showCategory(this.currentCategory);
        },
      );
      this.navButtons.push(prevButton);
    }

    if (this.menuPage < totalPages - 1) {
      const nextButton = this.createMenuButton(
        "Next\nPage",
        2.5,
        -0.5,
        -1.9,
        0xff5722,
        () => {
          this.menuPage++;
          this.showCategory(this.currentCategory);
        },
      );
      this.navButtons.push(nextButton);
    }
  }

  updateMenuTitle(text) {
    if (this.menuTitleTextMesh) {
      this.menuTitleTextMesh.updateText(text);
    }
  }

  sendCommand(commandId, commandName) {
    if (
      !this.rtc ||
      !this.rtc.channel ||
      this.rtc.channel.readyState !== "open"
    ) {
      this.vrLog(`Cannot send ${commandName}: No connection`);
      return;
    }

    this.vrLog(`Sending command: ${commandName} (${commandId})`);

    // Send the command to the robot
    this.rtc.publishApi("rt/api/sport/request", commandId, "");

    // Provide feedback
    this.menuTitleTextMesh.updateText(`SENT: ${commandName.toUpperCase()}`);

    // Reset title after 2 seconds
    setTimeout(() => {
      if (this.currentCategory) {
        this.menuTitleTextMesh.updateText(
          `${this.currentCategory.toUpperCase()} COMMANDS`,
        );
      } else {
        this.menuTitleTextMesh.updateText("ROBOT COMMANDS - Select Category");
      }
    }, 2000);
  }
}

// Initialize WebXR when the script loads
document.addEventListener("DOMContentLoaded", () => {
  const webxr = new WebXRController();
});

export { WebXRController };
