// Three.js Web Worker for processing voxel data
// This runs in a separate thread to avoid blocking the main UI

class VoxelProcessor {
  constructor() {
    this.cellSize_X = 128;
    this.cellSize_Y = 128;
    this.cellSize_Z = 30;
    this.faces = [
      {
        dir: [-1, 0, 0],
        corners: [
          { pos: [0, 1, 0], uv: [0, 1] },
          { pos: [0, 0, 0], uv: [1, 1] },
          { pos: [0, 1, 1], uv: [0, 0] },
          { pos: [0, 0, 1], uv: [1, 0] },
        ],
      },
      {
        dir: [1, 0, 0],
        corners: [
          { pos: [1, 1, 1], uv: [1, 0] },
          { pos: [1, 0, 1], uv: [0, 0] },
          { pos: [1, 1, 0], uv: [1, 1] },
          { pos: [1, 0, 0], uv: [0, 1] },
        ],
      },
      {
        dir: [0, -1, 0],
        corners: [
          { pos: [1, 0, 1], uv: [1, 0] },
          { pos: [0, 0, 1], uv: [0, 0] },
          { pos: [1, 0, 0], uv: [1, 1] },
          { pos: [0, 0, 0], uv: [0, 1] },
        ],
      },
      {
        dir: [0, 1, 0],
        corners: [
          { pos: [0, 1, 1], uv: [0, 0] },
          { pos: [1, 1, 1], uv: [1, 0] },
          { pos: [0, 1, 0], uv: [0, 1] },
          { pos: [1, 1, 0], uv: [1, 1] },
        ],
      },
      {
        dir: [0, 0, -1],
        corners: [
          { pos: [1, 0, 0], uv: [0, 0] },
          { pos: [0, 0, 0], uv: [1, 0] },
          { pos: [1, 1, 0], uv: [0, 1] },
          { pos: [0, 1, 0], uv: [1, 1] },
        ],
      },
      {
        dir: [0, 0, 1],
        corners: [
          { pos: [0, 0, 1], uv: [0, 0] },
          { pos: [1, 0, 1], uv: [1, 0] },
          { pos: [0, 1, 1], uv: [0, 1] },
          { pos: [1, 1, 1], uv: [1, 1] },
        ],
      },
    ];
  }

  calBitForIndex(value, bitIndex) {
    return (value >> (7 - bitIndex)) & 1;
  }

  getVoxel(data, x, y, z) {
    if (
      x >= this.cellSize_X ||
      y >= this.cellSize_Y ||
      z >= this.cellSize_Z ||
      x < 0 ||
      y < 0 ||
      z < 0
    ) {
      return 0;
    }

    const index =
      this.cellSize_X * this.cellSize_Y * z + this.cellSize_X * y + x;
    const byteIndex = Math.floor(index / 8);
    const bitIndex = index % 8;

    if (byteIndex >= data.length) return 0;

    return this.calBitForIndex(data[byteIndex], bitIndex);
  }

  adjacent(data, pos) {
    const [x, y, z] = pos;
    return this.getVoxel(data, x, y, z);
  }

  generateGeometryData(data, dimensions, resolution, origin) {
    const [width, height, depth] = dimensions;
    this.cellSize_X = width;
    this.cellSize_Y = height;
    this.cellSize_Z = depth;

    const positions = [];
    const uvs = [];
    const indices = [];

    let pointCount = 0;

    for (let byteIndex = 0; byteIndex < data.length; byteIndex++) {
      if (data[byteIndex] > 0) {
        const byteValue = data[byteIndex];

        for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
          if (this.calBitForIndex(byteValue, bitIndex)) {
            const voxelIndex = byteIndex * 8 + bitIndex;
            pointCount++;

            const z = Math.floor(voxelIndex / (width * height));
            const remainder = voxelIndex % (width * height);
            const y = Math.floor(remainder / width);
            const x = remainder % width;

            // Calculate height-based color/elevation
            const worldZ =
              (z * resolution + origin[2]) * Math.round(1 / resolution);
            const colorIndex = Math.floor(
              (worldZ < -10 ? -10 : worldZ > 20 ? 20 : worldZ) + 10
            );

            // Generate faces for this voxel
            for (const { dir, corners } of this.faces) {
              const neighborX = x + dir[0];
              const neighborY = y + dir[1];
              const neighborZ = z + dir[2];

              // Only render face if neighbor voxel doesn't exist
              if (!this.adjacent(data, [neighborX, neighborY, neighborZ])) {
                const faceIndexStart = positions.length / 3;

                // Add vertices for this face
                for (const { pos, uv } of corners) {
                  positions.push(pos[0] + x, pos[1] + y, pos[2] + z);
                  uvs.push((colorIndex + uv[0]) / 32, 1 - (1 - uv[1]) / 32);
                }

                // Add indices for two triangles
                indices.push(
                  faceIndexStart,
                  faceIndexStart + 1,
                  faceIndexStart + 2,
                  faceIndexStart + 2,
                  faceIndexStart + 1,
                  faceIndexStart + 3
                );
              }
            }
          }
        }
      }
    }

    return {
      positions: positions,
      uvs: uvs,
      indices: indices,
      pointCount: pointCount,
    };
  }
}

const processor = new VoxelProcessor();

// Handle messages from main thread
self.onmessage = function (e) {
  const { resolution, origin, width, data } = e.data;

  try {
    console.log("Worker processing voxel data:", {
      resolution,
      origin,
      width,
      dataLength: data.length,
    });

    // Assume dimensions based on width (square grid)
    const dimensions = [
      width,
      width,
      Math.ceil((data.length * 8) / (width * width)),
    ];

    const geometryData = processor.generateGeometryData(
      data,
      dimensions,
      resolution,
      origin
    );

    // Post result back to main thread
    self.postMessage({
      geometryData: geometryData,
      resolution: resolution,
      origin: origin,
    });

    console.log("Worker processed geometry:", geometryData);
  } catch (error) {
    console.error("Worker error:", error);
    self.postMessage({ error: error.message });
  }
};
