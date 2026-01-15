import { Go2WebRTC } from "./go2webrtc.js";
import { DataChannelType } from "./constants.js";

globalThis.logMessage = console.log;

// Function to print incoming data
function setIncomingData(data) {
  console.log("setIncomingData", data);

  if (
    globalThis.rtc.validationResult === "SUCCESS" &&
    data.type === DataChannelType.VALIDATION
  ) {
    console.log(
      "Validation successful - saving token to localStorage for future use"
    );
    // Save the working token for future connections (like index.html does)
    localStorage.setItem("token", globalThis.rtc.token);
    localStorage.setItem("robotIP", globalThis.rtc.robotIP);

    console.log("Subscribing to topic rt/utlidar/voxel_map_compressed");
    globalThis.rtc.channel.send(
      JSON.stringify({
        type: "subscribe",
        topic: "rt/utlidar/voxel_map_compressed",
      })
    );
  }

  if (data.type === "msg" && data.topic === "rt/utlidar/voxel_map_compressed") {
    console.log("Received voxel map data:", data.data);
    globalThis.voxelMap = data.data;

    // Send to Three.js worker for processing
    if (window._threejsworker && data.data) {
      try {
        // Process the compressed voxel data
        const voxelData = new Uint8Array(data.data);
        const _jsonLength = voxelData[0];
        const _jsonOffset = 4;
        const _jsonString = String.fromCharCode.apply(
          null,
          voxelData.slice(_jsonOffset, _jsonOffset + _jsonLength)
        );
        const jsonOBJ = JSON.parse(_jsonString);

        window._threejsworker.postMessage({
          resolution: jsonOBJ.data.resolution,
          origin: jsonOBJ.data.origin,
          width: jsonOBJ.data.width,
          data: voxelData.slice(_jsonOffset + _jsonLength),
        });
      } catch (e) {
        console.error("Error processing voxel data:", e);
      }
    }
  }
}

// Function to load saved values from localStorage
function loadSavedValues() {
  // Option 1: Load from localStorage (set via index.html)
  let savedToken = localStorage.getItem("token");
  let savedRobotIP = localStorage.getItem("robotIP");

  // Option 2: Auto-connect and save token like index.html does
  if (!savedToken) {
    console.log(
      "No token found - will auto-connect to get token (like index.html does)"
    );
    savedToken = ""; // Start with empty token, will get proper token after validation
  }
  if (!savedRobotIP) savedRobotIP = "10.0.0.207"; // Default robot IP

  console.log("Using Token:", savedToken);
  console.log("Using Robot IP:", savedRobotIP);

  // Initialize RTC
  if (savedToken && savedRobotIP) {
    console.log(
      "Connecting to robot at",
      savedRobotIP,
      "with token:",
      savedToken.substring(0, 20) + "..."
    );
    globalThis.rtc = new Go2WebRTC(savedToken, savedRobotIP, setIncomingData);
    globalThis.rtc.initSDP();
  } else if (savedRobotIP) {
    console.warn("Robot IP set to:", savedRobotIP, "but no token found!");
    console.warn("You need to provide a JWT token. Options:");
    console.warn(
      "1. Connect via index.html first to save token to localStorage"
    );
    console.warn(
      "2. Uncomment and set: savedToken = 'YOUR_JWT_TOKEN_HERE'; in this file"
    );
    console.warn("3. Sniff network traffic to get the JWT token");
  } else {
    console.warn(
      "No robot IP found. Set savedRobotIP = '10.0.0.207'; or connect via index.html first."
    );
  }
}

// Load saved values when the page loads
document.addEventListener("DOMContentLoaded", loadSavedValues);
