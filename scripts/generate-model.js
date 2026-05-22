/* ============================================================
   scripts/generate-model.js
   ============================================================ */

const tf  = require('@tensorflow/tfjs');
require('@tensorflow/tfjs-backend-cpu');
const path = require('path');
const fs   = require('fs');

const OUTPUT_DIR  = path.join(__dirname, '../frontend/assets/model');
const NUM_CLASSES = 5;

function buildModel() {
  const model = tf.sequential();
  model.add(tf.layers.conv2d({
    inputShape: [28, 28, 1],
    filters:    16,
    kernelSize: 3,
    activation: 'relu',
    padding:    'same',
  }));
  model.add(tf.layers.maxPooling2d({ poolSize: 2 }));
  model.add(tf.layers.conv2d({
    filters:    32,
    kernelSize: 3,
    activation: 'relu',
    padding:    'same',
  }));
  model.add(tf.layers.maxPooling2d({ poolSize: 2 }));
  model.add(tf.layers.flatten());
  model.add(tf.layers.dense({ units: 64, activation: 'relu' }));
  model.add(tf.layers.dropout({ rate: 0.3 }));
  model.add(tf.layers.dense({ units: NUM_CLASSES, activation: 'softmax' }));
  model.compile({
    optimizer: 'adam',
    loss:      'categoricalCrossentropy',
    metrics:   ['accuracy'],
  });
  return model;
}

async function main() {
  await tf.setBackend('cpu');
  await tf.ready();

  console.log('Building model...');
  const model = buildModel();

  // toJSON() returns a STRING — must parse it first
  const topologyObj = JSON.parse(model.toJSON());
  console.log('class_name:', topologyObj.class_name);

  // Collect weights
  const weightData  = [];
  const weightSpecs = [];
  for (const variable of model.getWeights()) {
    const data = variable.dataSync();
    weightSpecs.push({
      name:  variable.name,
      shape: variable.shape,
      dtype: variable.dtype,
    });
    for (let i = 0; i < data.length; i++) weightData.push(data[i]);
  }
  const weightBuffer = Buffer.from(new Float32Array(weightData).buffer);

  // Build model.json — use the parsed topology directly
  const modelJSON = {
    modelTopology:   topologyObj,
    weightsManifest: [
      {
        paths:   ['weights.bin'],
        weights: weightSpecs,
      }
    ],
    format:      'layers-model',
    generatedBy: 'TensorFlow.js tfjs-layers v4.22.0',
    convertedBy: null,
  };

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'model.json'),
    JSON.stringify(modelJSON, null, 2)
  );
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'weights.bin'),
    weightBuffer
  );

  console.log('Done.');
}

main().catch(console.error);