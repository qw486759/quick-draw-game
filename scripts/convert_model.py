"""
convert_model.py
Manually convert a Keras .h5 model to TF.js LayersModel format.
Does NOT use tensorflowjs package.

Usage:
    python scripts/convert_model.py
"""

import os
import json
import numpy as np
import tensorflow as tf

# ── Config ─────────────────────────────────────────────────────────────────
H5_INPUT_PATH    = os.path.join(os.path.dirname(__file__), 'quickdraw_model.h5')
MODEL_OUTPUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'assets', 'model')
# ──────────────────────────────────────────────────────────────────────────

# Keras stores weights with these suffixes
WEIGHT_NAME_MAP = {
    'kernel': 'kernel',
    'bias':   'bias',
}

def convert():
    print('Loading model from:', H5_INPUT_PATH)
    model = tf.keras.models.load_model(H5_INPUT_PATH)
    model.summary()

    os.makedirs(MODEL_OUTPUT_DIR, exist_ok=True)

    # ── Collect weights using TF.js expected naming convention ────────────
    # TF.js expects names like: "dense/dense/kernel", "dense/dense/bias"
    all_weight_data   = []
    weight_manifest   = []
    byte_offset       = 0

    weights_bin_path  = os.path.join(MODEL_OUTPUT_DIR, 'weights.bin')

    with open(weights_bin_path, 'wb') as f:
        for layer in model.layers:
            layer_weights = layer.weights  # list of tf.Variable
            for var in layer_weights:
                # var.name looks like: "conv2d/kernel:0"
                # TF.js expects:       "conv2d/conv2d/kernel"
                raw_name   = var.name.replace(':0', '')   # "conv2d/kernel"
                parts      = raw_name.split('/')
                layer_name = parts[0]                     # "conv2d"
                param_name = parts[-1]                    # "kernel" or "bias"

                # TF.js LayersModel weight name format: "layer/layer/param"
                tfjs_name  = f'{layer_name}/{param_name}'

                w          = var.numpy().astype(np.float32)
                data       = w.flatten().tobytes()
                f.write(data)

                weight_manifest.append({
                    'name':  tfjs_name,
                    'shape': list(w.shape),
                    'dtype': 'float32',
                })

                print(f'  {tfjs_name}  shape={list(w.shape)}  bytes={len(data)}')
                byte_offset += len(data)

    print(f'\nWeights written: {weights_bin_path} ({byte_offset} bytes)')

    # ── Build model.json ──────────────────────────────────────────────────
    model_config = json.loads(model.to_json())

    model_json = {
        'format':         'layers-model',
        'generatedBy':    'keras',
        'convertedBy':    'quickdraw-converter',
        'modelTopology':  model_config,
        'weightsManifest': [
            {
                'paths':   ['weights.bin'],
                'weights': weight_manifest,
            }
        ],
    }

    model_json_path = os.path.join(MODEL_OUTPUT_DIR, 'model.json')
    with open(model_json_path, 'w') as f:
        json.dump(model_json, f)

    print(f'Model JSON written: {model_json_path}')
    print('\nConversion complete!')

if __name__ == '__main__':
    convert()