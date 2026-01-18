import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory.js";
import { Go2WebRTC } from "./go2webrtc.js";

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

    // Microphone settings
    this.microphoneEnabled = false;

    // Menu system properties
    this.menuVisible = false;
    this.selectedMenuItem = -1;
    this.currentCategory = null;
    this.menuPage = 0;
    this.menuItemsPerPage = 8;
    this.lastButtonStates = {
      leftMenu: false,
      rightMenu: false,
      leftTrigger: false,
      rightTrigger: false,
      rightSelect: false,
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
      await this.videoElement.play();
      this.vrLog("Video play permission granted!");
      return true;
    } catch (err) {
      this.vrLog(`Video play blocked: ${err.name}`);

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

    // Check for AR and VR support
    const isARSupported = await navigator.xr.isSessionSupported("immersive-ar");
    const isVRSupported = await navigator.xr.isSessionSupported("immersive-vr");

    console.log(
      `AR supported: ${isARSupported}, VR supported: ${isVRSupported}`,
    );

    if (!isARSupported && !isVRSupported) {
      console.error("Neither Immersive AR nor VR supported");
      return;
    }

    // Initialize Three.js scene
    this.setupScene();

    // Create appropriate buttons based on device capabilities
    const buttonContainer = document.createElement("div");
    buttonContainer.style.position = "absolute";
    buttonContainer.style.bottom = "20px";
    buttonContainer.style.left = "50%";
    buttonContainer.style.transform = "translateX(-50%)";
    buttonContainer.style.display = "flex";
    buttonContainer.style.gap = "10px";

    if (isARSupported) {
      // Create AR button for passthrough
      const arButton = VRButton.createButton(this.renderer, {
        referenceSpaceType: "local-floor",
        mode: "immersive-ar",
      });
      arButton.textContent = "Enter AR (Passthrough)";
      arButton.style.backgroundColor = "#4CAF50";
      buttonContainer.appendChild(arButton);
    }

    if (isVRSupported) {
      // Create VR button
      const vrButton = VRButton.createButton(this.renderer);
      vrButton.textContent = "Enter VR";
      vrButton.style.backgroundColor = "#2196F3";
      buttonContainer.appendChild(vrButton);
    }

    document.body.appendChild(buttonContainer);

    this.renderer.setAnimationLoop((timestamp, frame) => {
      this.render(timestamp, frame);
    });

    console.log("WebXR initialized");
  }

  setupScene() {
    // Create scene
    this.scene = new THREE.Scene();
    this.scene.background = null; // CRITICAL for AR passthrough

    // Create camera
    this.camera = new THREE.PerspectiveCamera(
      70,
      window.innerWidth / window.innerHeight,
      0.1,
      1000,
    );

    // Create renderer - MINIMAL setup for AR
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.xr.enabled = true;
    // DO NOT set preserveDrawingBuffer or autoClear
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
    this.videoElement.id = "video-frame";
    this.videoElement.style.display = "none";
    this.videoElement.autoplay = true;
    this.videoElement.muted = true;
    this.videoElement.playsInline = true;
    document.body.appendChild(this.videoElement);

    // Create hidden audio element for WebRTC audio stream
    this.audioElement = document.createElement("audio");
    this.audioElement.id = "audio-frame";
    this.audioElement.style.display = "none";
    this.audioElement.autoplay = true;
    this.audioElement.muted = false;
    this.audioElement.volume = 1.0;
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
        this.videoScreen.material.color.set(0xffffff);
        this.videoScreen.material.needsUpdate = true;
        this.videoTexture.needsUpdate = true;
        this.vrLog("Red tint removed!");
      });

      this.videoElement.addEventListener("loadeddata", () => {
        this.vrLog("Video data loaded!");

        this.videoScreen.material.map = this.videoTexture;
        this.videoScreen.material.color.set(0xffffff);
        this.videoScreen.material.needsUpdate = true;
        this.videoTexture.needsUpdate = true;
      });

      this.videoElement.addEventListener("playing", () => {
        this.vrLog("Video PLAYING!");

        this.videoScreen.material.map = this.videoTexture;
        this.videoScreen.material.color.set(0xffffff);
        this.videoScreen.material.needsUpdate = true;
        this.videoTexture.needsUpdate = true;
      });

      this.videoElement.addEventListener("canplay", () => {
        this.vrLog("Video can play!");

        this.videoScreen.material.map = this.videoTexture;
        this.videoScreen.material.color.set(0xffffff);
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
    panel.rotation.y = x > 0 ? -Math.PI * 0.1 : Math.PI * 0.1;

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

    const controller = this.controllers[index];

    // CRITICAL: Store gamepad reference from event
    controller.gamepad = event.data.gamepad;

    const controllerGrip = this.renderer.xr.getControllerGrip(index);

    // Load dynamic controller models
    const controllerModelFactory = new XRControllerModelFactory();
    const controllerModel =
      controllerModelFactory.createControllerModel(controllerGrip);
    controllerGrip.add(controllerModel);

    this.scene.add(controllerGrip);

    // Add laser pointer to RIGHT controller
    if (index === 1) {
      this.laserPointer = this.createLaserPointer(controller);
      this.vrLog("Laser added to RIGHT controller");
    }

    // Setup joystick input handling
    this.setupJoystickInput(index);

    this.vrLog(
      `Controller ${index} (${index === 0 ? "LEFT" : "RIGHT"}) gamepad stored`,
    );
  }

  onControllerDisconnected(event, index) {
    console.log(`Controller ${index} disconnected`);
    const controller = this.controllers[index];
    if (controller) {
      controller.gamepad = null;
    }
  }

  setupJoystickInput(controllerIndex) {
    const controller = this.controllers[controllerIndex];

    // Add select events for triggers
    controller.addEventListener("selectstart", (event) => {
      console.log(
        `Controller ${controllerIndex} trigger pressed (selectstart)`,
      );
      this.vrLog(`Controller ${controllerIndex} trigger pressed!`);

      // If this is the right controller and menu is visible, handle selection
      if (controllerIndex === 1 && this.menuVisible) {
        this.vrLog("Right trigger - selecting menu item");
        this.handleMenuSelection();
      }

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
        }
      }
    });

    controller.addEventListener("selectend", (event) => {
      console.log(`Controller ${controllerIndex} trigger released (selectend)`);
    });

    controller.addEventListener("select", (event) => {
      console.log(`Controller ${controllerIndex} trigger select (full press)`);
    });

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

          // Fallback to axes[0] and axes[1]
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

          // Fallback to axes[0]
          if (rightStickX === 0 && gamepad.axes.length > 1) {
            const x0 = gamepad.axes[0] || 0;
            if (Math.abs(x0) > deadzone) {
              rightStickX = x0;
            }
          }
        }
      }
    }

    const forward = -leftStickY * this.movementSpeed;
    const strafe = -leftStickX * this.movementSpeed;
    const turn = -rightStickX * this.movementSpeed;

    if (!this.prevMovement) {
      this.prevMovement = { forward: 0, strafe: 0, turn: 0 };
    }

    const hasInput =
      Math.abs(forward) > 0.01 ||
      Math.abs(strafe) > 0.01 ||
      Math.abs(turn) > 0.01;
    const hadInput =
      Math.abs(this.prevMovement.forward) > 0.01 ||
      Math.abs(this.prevMovement.strafe) > 0.01 ||
      Math.abs(this.prevMovement.turn) > 0.01;

    if (hasInput || hadInput) {
      const now = Date.now();
      if (now - this.lastMovementTime < 100) {
        return;
      }
      this.lastMovementTime = now;

      if (hasInput) {
        this.vrLog(
          `Move: F${forward.toFixed(1)}, S${strafe.toFixed(1)}, T${turn.toFixed(1)}`,
        );
      } else if (hadInput && !hasInput) {
        this.vrLog("STOP");
      }

      this.sendMovement(forward, strafe, turn);
      this.prevMovement = { forward, strafe, turn };
    }
  }

  sendMovement(x, y, z) {
    if (!this.rtc) {
      this.vrLog("Move failed: No RTC");
      return;
    }

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
      1008,
      JSON.stringify({ x: x, y: y, z: z }),
    );
  }

  async connectToRobot() {
    try {
      const robotIP = "10.0.0.207";
      const token = localStorage.getItem("token") || "";

      this.updateStatusPanel(
        `STATUS\nRobot: ${robotIP}\nConnection: Connecting...`,
      );

      console.log(`Auto-connecting to robot at ${robotIP}`);

      globalThis.logMessage = (msg) => {
        console.log("[Go2WebRTC]", msg);
        this.vrLog(`[RTC] ${msg}`);
      };

      this.vrLog("Initializing WebRTC...");
      const signalingServer = "10.0.0.43";
      this.rtc = new Go2WebRTC(token, robotIP, null, signalingServer);

      // Monitor track events
      this.rtc.pc.addEventListener("track", (event) => {
        this.vrLog(`Track event: ${event.track.kind}`);
        console.log("Track event received:", event);

        if (event.track.kind === "video") {
          this.vrLog("Video track received!");
          console.log("Video track details:", event.track);
          console.log("Video streams:", event.streams);

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
          this.vrLog("Audio track received!");
          console.log("Audio track details:", event.track);
          console.log("Audio streams:", event.streams);

          setTimeout(() => {
            if (this.audioElement.srcObject) {
              this.vrLog("Audio srcObject assigned by go2webrtc!");
              this.audioElement
                .play()
                .then(() => {
                  this.vrLog("Audio playing!");
                })
                .catch((err) => {
                  this.vrLog(`Audio play failed: ${err.message}`);
                });
            } else {
              this.vrLog("No audio srcObject - assigning manually...");
              if (event.streams && event.streams[0]) {
                this.audioElement.srcObject = event.streams[0];
                this.audioElement
                  .play()
                  .then(() => {
                    this.vrLog("Audio playing!");
                  })
                  .catch((err) => {
                    this.vrLog(`Audio play failed: ${err.message}`);
                  });
              }
            }
          }, 100);
        }
      });

      // ICE state monitoring
      this.rtc.pc.addEventListener("iceconnectionstatechange", () => {
        const state = this.rtc.pc.iceConnectionState;
        this.vrLog(`ICE State: ${state}`);
        console.log("ICE connection state changed:", state);

        if (state === "disconnected") {
          this.vrLog("ICE DISCONNECTED! Will retry...");
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

      // Enable microphone if setting is on
      if (this.microphoneEnabled) {
        try {
          await this.rtc.enableMicrophone();
          this.vrLog("Microphone enabled");
        } catch (error) {
          console.log(
            "Microphone access denied, robot may not respond to movement commands",
          );
          this.vrLog("Mic denied - movement may not work");
        }
      } else {
        this.vrLog("Microphone disabled by user setting");
      }

      // Create SDP offer
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
            }

            this.updateStatusPanel(
              `STATUS\nRobot: ${robotIP}\nConnection: Connected ✓\nICE: ${this.rtc.pc.iceConnectionState}`,
            );
            clearInterval(this.channelMonitor);
          } else if (state === "connecting") {
            // Channel still connecting
          } else if (state === "closed") {
            this.vrLog("Channel CLOSED!");
          } else {
            this.vrLog(`Channel ${state}`);
          }
        } else {
          this.vrLog("No channel object yet");
        }
      };

      monitorChannel();
      this.channelMonitor = setInterval(monitorChannel, 2000);

      // Periodically check video status
      this.videoStatusChecker = setInterval(() => {
        this.checkVideoStatus();
      }, 10000);

      // Start requesting robot state
      this.startStateUpdates();

      this.updateStatusPanel(
        `STATUS\nRobot: ${robotIP}\nConnection: Initializing...`,
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
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array([0, 0, 0, 0, 0, -5]);
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

    const material = new THREE.LineBasicMaterial({
      color: 0x00ff00,
      linewidth: 2,
      opacity: 0.8,
      transparent: true,
    });

    const laser = new THREE.Line(geometry, material);

    const dotGeometry = new THREE.SphereGeometry(0.02, 8, 8);
    const dotMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
    const dot = new THREE.Mesh(dotGeometry, dotMaterial);
    dot.position.set(0, 0, -5);
    laser.add(dot);

    laser.visible = false;
    controller.add(laser);

    return laser;
  }

  render(timestamp, frame) {
    if (!frame) return;

    if (this.renderer.xr.isPresenting && !this.isConnected && !this.rtc) {
      const micCheckbox = document.getElementById("enableMicrophone");
      this.microphoneEnabled = micCheckbox ? micCheckbox.checked : false;

      this.vrLog(
        `Microphone setting: ${this.microphoneEnabled ? "enabled" : "disabled"}`,
      );
      this.connectToRobot();
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

    // Update menu
    this.updateMenuButtons();
    if (this.menuVisible) {
      this.updateMenuRaycasting();
    }

    // Three.js automatically handles XR rendering - just call render
    this.renderer.render(this.scene, this.camera);
  }

  updateDebugInfo(info) {
    console.log("VR Debug:", info);
  }

  updateDebugPanel(text) {
    if (this.debugTextMesh) {
      this.debugTextMesh.updateText(text);
    }
  }

  vrLog(message) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `${timestamp.slice(-8)}: ${message}`;

    console.log(`[VR] ${logEntry}`);

    this.debugLogs.push(logEntry);

    if (this.debugLogs.length > this.maxDebugLogs) {
      this.debugLogs.shift();
    }

    const debugText = "DEBUG LOG\n" + this.debugLogs.join("\n");
    this.updateDebugPanel(debugText);
  }

  updateStatusPanel(text) {
    if (this.statusTextMesh) {
      this.statusTextMesh.updateText(text);
    }
  }

  startStateUpdates() {
    this.stateUpdateInterval = setInterval(() => {
      this.requestRobotState();
    }, 2000);

    this.setupStateMessageHandler();
  }

  requestRobotState() {
    if (
      !this.rtc ||
      !this.rtc.channel ||
      this.rtc.channel.readyState !== "open"
    ) {
      return;
    }

    this.rtc.publishApi("rt/api/sport/request", 1034, "");
  }

  setupStateMessageHandler() {
    if (!this.rtc) return;

    const originalCallback = this.rtc.messageCallback;
    this.rtc.messageCallback = (data) => {
      if (data && data.topic) {
        if (
          data.topic.includes("sportmodestate") ||
          data.topic.includes("servicestate")
        ) {
          this.handleStateMessage(data);
        }
      }

      if (originalCallback) {
        originalCallback(data);
      }
    };
  }

  handleStateMessage(data) {
    try {
      console.log("State message received:", data);

      if (data.data) {
        this.robotState = { ...this.robotState, ...data.data };
        this.lastStateUpdate = Date.now();
        this.updateHUDPanels();
      }
    } catch (error) {
      console.error("Error handling state message:", error);
    }
  }

  updateHUDPanels() {
    this.updateMovementHUD();
    this.updateBatterySensorsHUD();
    this.updateRobotStateHUD();
  }

  updateMovementHUD() {
    const velocity = this.robotState.velocity || "--";
    const mode = this.robotState.mode || "Manual";
    const gait = this.robotState.gait || "Walk";

    const hudText = `MOVEMENT HUD\nVelocity: ${velocity}\nMode: ${mode}\nGait: ${gait}`;

    if (this.hudTextMesh) {
      this.hudTextMesh.updateText(hudText);
    }
  }

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

  stopStateUpdates() {
    if (this.stateUpdateInterval) {
      clearInterval(this.stateUpdateInterval);
      this.stateUpdateInterval = null;
    }
  }

  updateMenuButtons() {
    if (!this.renderer.xr.isPresenting) return;

    const rightController = this.controllers[1];
    if (!rightController || !rightController.gamepad) return;

    const gamepad = rightController.gamepad;

    const menuButton = gamepad.buttons[5];
    const menuPressed = menuButton && menuButton.pressed;

    if (menuPressed && !this.lastButtonStates.rightMenu) {
      this.toggleMenu();
    }
    this.lastButtonStates.rightMenu = menuPressed;
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

    if (this.laserPointer) {
      this.laserPointer.visible = true;
    }

    this.hideCommandButtons();

    if (this.categoryButtons) {
      this.categoryButtons.forEach((b) => {
        b.panel.visible = true;
      });
    }

    this.currentCategory = null;
    this.menuTitleTextMesh.updateText("ROBOT COMMANDS - Select Category");

    this.vrLog("Menu opened");
  }

  hideMenu() {
    this.menuVisible = false;

    if (this.menuGroup) {
      this.menuGroup.visible = false;
    }

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

    const controller = this.controllers[1];
    if (!controller) {
      this.vrLog("No right controller found!");
      return;
    }

    const raycaster = new THREE.Raycaster();
    const tempMatrix = new THREE.Matrix4();

    tempMatrix.identity().extractRotation(controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

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

    const intersects = raycaster.intersectObjects(interactiveObjects, false);

    if (intersects.length > 0) {
      const hit = intersects[0];
      this.vrLog(`Raycast hit at distance: ${hit.distance.toFixed(2)}m`);
    }

    if (intersects.length > 0) {
      const selectedObject = intersects[0].object;

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
        if (
          !this.lastLoggedButton ||
          this.lastLoggedButton !== selectedButton
        ) {
          this.vrLog(
            `Hovering: ${selectedButton.panel.userData.type || "button"}`,
          );
          this.lastLoggedButton = selectedButton;
        }
      }
    } else {
      this.selectedButton = null;
      this.lastLoggedButton = null;
    }
  }

  handleMenuSelection() {
    this.vrLog(
      `Selection attempt - visible: ${this.menuVisible}, selected: ${!!this.selectedButton}`,
    );

    if (!this.menuVisible) {
      this.vrLog("Menu not visible, ignoring button");
      return;
    }

    if (!this.selectedButton) {
      this.vrLog("No button highlighted by raycast");
      return;
    }

    this.vrLog(
      `Executing action for: ${this.selectedButton.panel.userData.type}`,
    );

    if (this.selectedButton.panel.userData.onClick) {
      this.selectedButton.panel.userData.onClick();
      this.vrLog("Action executed!");
    } else {
      this.vrLog("ERROR: No onClick function found!");
    }
  }

  createCommandMenu() {
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

    this.createMenuBackground();
    this.createMenuCategories();
    this.hideMenu();
    this.vrLog("Menu created (hidden)");
  }

  createMenuBackground() {
    this.menuGroup = new THREE.Group();
    this.menuGroup.position.set(0, 1.5, -2);

    const bgGeometry = new THREE.PlaneGeometry(2.5, 2);
    const bgMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.85,
    });
    this.menuBackground = new THREE.Mesh(bgGeometry, bgMaterial);
    this.menuBackground.position.set(0, 0, 0);

    const borderGeometry = new THREE.EdgesGeometry(bgGeometry);
    const borderMaterial = new THREE.LineBasicMaterial({
      color: 0x00ff00,
      linewidth: 2,
    });
    const border = new THREE.LineSegments(borderGeometry, borderMaterial);
    this.menuBackground.add(border);

    this.menuGroup.add(this.menuBackground);

    const titleCanvas = document.createElement("canvas");
    const titleContext = titleCanvas.getContext("2d");
    titleCanvas.width = 512;
    titleCanvas.height = 128;

    const titleTexture = new THREE.CanvasTexture(titleCanvas);
    const titleGeometry = new THREE.PlaneGeometry(2, 0.3);
    const titleMaterial = new THREE.MeshBasicMaterial({
      map: titleTexture,
      transparent: true,
    });

    this.menuTitlePanel = new THREE.Mesh(titleGeometry, titleMaterial);
    this.menuTitlePanel.position.set(0, 0.85, 0.01);
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

    this.scene.add(this.menuGroup);
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
      { name: "Basic", key: "basic", x: -0.8, color: 0x4caf50 },
      { name: "Tricks", key: "tricks", x: 0, color: 0xff9800 },
      { name: "Movement", key: "movement", x: 0.8, color: 0x2196f3 },
    ];

    this.categoryButtons = [];

    categories.forEach((cat) => {
      const button = this.createMenuButton(
        cat.name,
        cat.x,
        0.3,
        0.01,
        cat.color,
        () => this.showCategory(cat.key),
      );
      this.categoryButtons.push(button);
      this.menuGroup.add(button.panel);
    });
  }

  createMenuButton(text, x, y, z, color, onClick) {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    canvas.width = 256;
    canvas.height = 128;

    const texture = new THREE.CanvasTexture(canvas);
    const buttonGeometry = new THREE.PlaneGeometry(0.7, 0.35);
    const buttonMaterial = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
    });

    const button = new THREE.Mesh(buttonGeometry, buttonMaterial);
    button.position.set(x, y, z);
    button.userData = { onClick, type: "button", color };

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

    const textMesh = {
      canvas,
      context,
      texture,
      updateText: (newText) => {
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
        context.fillRect(0, 0, canvas.width, canvas.height);

        context.fillStyle = "#ffffff";
        context.font = "bold 16px Arial";
        context.textAlign = "center";
        context.textBaseline = "middle";

        const lines = newText.split("\n");
        lines.forEach((line, i) => {
          context.fillText(
            line,
            canvas.width / 2,
            canvas.height / 2 + (i - 0.5) * 20,
          );
        });

        texture.needsUpdate = true;
      },
    };

    textMesh.updateText(text);

    return { panel: button, textMesh, wireframe };
  }

  showCategory(categoryKey) {
    this.hideCommandButtons();

    if (this.categoryButtons) {
      this.categoryButtons.forEach((b) => {
        b.panel.visible = false;
      });
    }

    const commands = this.robotCommands[categoryKey];
    if (!commands) return;

    this.currentCategory = categoryKey;
    this.commandButtons = [];

    const startIndex = this.menuPage * this.menuItemsPerPage;
    const endIndex = Math.min(
      startIndex + this.menuItemsPerPage,
      commands.length,
    );
    const visibleCommands = commands.slice(startIndex, endIndex);

    visibleCommands.forEach((cmd, index) => {
      const col = index % 2;
      const row = Math.floor(index / 2);
      const x = col * 0.9 - 0.45;
      const y = 0.3 - row * 0.45;

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

    if (commands.length > this.menuItemsPerPage) {
      this.addNavigationButtons(commands.length);
    }

    const backButton = this.createMenuButton(
      "← BACK",
      0,
      -0.9,
      0.01,
      0xff5722,
      () => {
        this.hideCommandButtons();
        if (this.categoryButtons) {
          this.categoryButtons.forEach((b) => {
            b.panel.visible = true;
          });
        }
        this.currentCategory = null;
        this.menuPage = 0;
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
        this.menuGroup.remove(button.panel);
      });
      this.commandButtons = [];
    }

    if (this.navButtons) {
      this.navButtons.forEach((button) => {
        this.menuGroup.remove(button.panel);
      });
      this.navButtons = [];
    }
  }

  addNavigationButtons(totalCommands) {
    this.navButtons = [];
    const totalPages = Math.ceil(totalCommands / this.menuItemsPerPage);

    if (this.menuPage > 0) {
      const prevButton = this.createMenuButton(
        "◄ PREV",
        -0.9,
        -0.8,
        0.01,
        0xff5722,
        () => {
          this.menuPage--;
          this.showCategory(this.currentCategory);
        },
      );
      this.navButtons.push(prevButton);
      this.menuGroup.add(prevButton.panel);
    }

    if (this.menuPage < totalPages - 1) {
      const nextButton = this.createMenuButton(
        "NEXT ►",
        0.9,
        -0.8,
        0.01,
        0xff5722,
        () => {
          this.menuPage++;
          this.showCategory(this.currentCategory);
        },
      );
      this.navButtons.push(nextButton);
      this.menuGroup.add(nextButton.panel);
    }

    if (totalPages > 1) {
      const pageIndicator = this.createMenuButton(
        `${this.menuPage + 1}/${totalPages}`,
        0,
        -0.8,
        0.01,
        0x333333,
        () => {},
      );
      this.navButtons.push(pageIndicator);
      this.menuGroup.add(pageIndicator.panel);
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

    this.rtc.publishApi("rt/api/sport/request", commandId, "");

    this.menuTitleTextMesh.updateText(`SENT: ${commandName.toUpperCase()}`);

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

document.addEventListener("DOMContentLoaded", () => {
  const webxr = new WebXRController();
});

export { WebXRController };
