"""
train_model.py
Train a CNN on Quick Draw .npy data and save as Keras .h5 format.
Then convert to TF.js using the command line tool separately.

Usage:
    python scripts/train_model.py
"""

import os
import numpy as np
import tensorflow as tf

# ── Config ─────────────────────────────────────────────────────────────────
CATEGORIES        = ['cat', 'house', 'star', 'fish', 'sun']
DATA_DIR          = os.path.join(os.path.dirname(__file__), 'data')
MODEL_OUTPUT_DIR  = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'assets', 'model')
WORDS_OUTPUT_DIR  = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'assets', 'words')
H5_OUTPUT_PATH    = os.path.join(os.path.dirname(__file__), 'quickdraw_model.h5')

SAMPLES_PER_CLASS = 15000
TRAIN_SPLIT       = 0.8
BATCH_SIZE        = 256
EPOCHS            = 15
IMAGE_SIZE        = 28
# ──────────────────────────────────────────────────────────────────────────


# ── Step 1: Load .npy files ────────────────────────────────────────────────
def load_data():
    print('\nLoading data...')
    all_images = []
    all_labels = []

    for class_idx, category in enumerate(CATEGORIES):
        file_path = os.path.join(DATA_DIR, f'{category}.npy')

        if not os.path.exists(file_path):
            print(f'\nERROR: File not found: {file_path}')
            print('Make sure all .npy files are in scripts/data/')
            exit(1)

        print(f'  Reading {category}.npy...')
        data  = np.load(file_path)
        total = data.shape[0]
        n     = min(SAMPLES_PER_CLASS, total)
        print(f'    Total: {total}, using: {n}')

        samples = data[:n].astype('float32')
        samples = 1.0 - samples / 255.0
        samples = samples.reshape(n, IMAGE_SIZE, IMAGE_SIZE, 1)

        all_images.append(samples)
        all_labels.extend([class_idx] * n)

    x = np.concatenate(all_images, axis=0)
    y = np.array(all_labels)

    total_samples = len(y)
    print(f'\n  Total samples: {total_samples}')

    print('  Shuffling data...')
    indices = np.random.permutation(total_samples)
    x, y    = x[indices], y[indices]

    y = tf.keras.utils.to_categorical(y, num_classes=len(CATEGORIES))

    train_count = int(total_samples * TRAIN_SPLIT)
    x_train, x_val = x[:train_count], x[train_count:]
    y_train, y_val = y[:train_count], y[train_count:]

    print(f'  Train: {train_count}, Validation: {total_samples - train_count}')
    return x_train, y_train, x_val, y_val


# ── Step 2: Build CNN model ────────────────────────────────────────────────
def build_model():
    print('\nBuilding CNN model...')

    model = tf.keras.Sequential([
        tf.keras.layers.Conv2D(32, (3, 3), activation='relu', padding='same',
                               input_shape=(IMAGE_SIZE, IMAGE_SIZE, 1)),
        tf.keras.layers.MaxPooling2D((2, 2)),
        tf.keras.layers.Dropout(0.25),

        tf.keras.layers.Conv2D(64, (3, 3), activation='relu', padding='same'),
        tf.keras.layers.MaxPooling2D((2, 2)),
        tf.keras.layers.Dropout(0.25),

        tf.keras.layers.Flatten(),
        tf.keras.layers.Dense(128, activation='relu'),
        tf.keras.layers.Dropout(0.5),
        tf.keras.layers.Dense(len(CATEGORIES), activation='softmax'),
    ])

    model.compile(
        optimizer=tf.keras.optimizers.Adam(learning_rate=0.001),
        loss='categorical_crossentropy',
        metrics=['accuracy'],
    )

    model.summary()
    return model


# ── Step 3: Train ──────────────────────────────────────────────────────────
def train_model(model, x_train, y_train, x_val, y_val):
    print(f'\nStarting training ({EPOCHS} epochs, batch size {BATCH_SIZE})...\n')

    history = model.fit(
        x_train, y_train,
        epochs=EPOCHS,
        batch_size=BATCH_SIZE,
        validation_data=(x_val, y_val),
        verbose=1,
    )

    final_acc     = history.history['accuracy'][-1]
    final_val_acc = history.history['val_accuracy'][-1]
    print(f'\nTraining complete.')
    print(f'  Final accuracy:     {final_acc * 100:.1f}%')
    print(f'  Final val accuracy: {final_val_acc * 100:.1f}%')


# ── Step 4: Quick validation ───────────────────────────────────────────────
def quick_validate(model, x_val, y_val):
    print('\nQuick validation (first 10 samples)...')

    samples      = x_val[:10]
    true_indices = np.argmax(y_val[:10], axis=1)
    pred_probs   = model.predict(samples, verbose=0)
    pred_indices = np.argmax(pred_probs, axis=1)

    correct = 0
    for i in range(10):
        pred  = CATEGORIES[pred_indices[i]]
        truth = CATEGORIES[true_indices[i]]
        mark  = 'OK' if pred == truth else 'WRONG'
        print(f'  [{i+1}] predicted: {pred:<10} actual: {truth:<10} {mark}')
        if pred == truth:
            correct += 1

    print(f'\n  Result: {correct}/10 correct')


# ── Step 5: Save as .h5 ────────────────────────────────────────────────────
def save_model(model):
    import json

    os.makedirs(WORDS_OUTPUT_DIR, exist_ok=True)

    # Save as Keras .h5 format
    model.save(H5_OUTPUT_PATH)
    print(f'\nModel saved to: {H5_OUTPUT_PATH}')

    # Write categories.json for the frontend
    categories_path = os.path.join(WORDS_OUTPUT_DIR, 'categories.json')
    with open(categories_path, 'w') as f:
        json.dump({'categories': CATEGORIES}, f, indent=2)
    print(f'Categories saved to: {categories_path}')

    print('\n---------------------------------------------')
    print('Next step: convert to TF.js format by running:')
    print(f'  tensorflowjs_converter --input_format keras {H5_OUTPUT_PATH} {MODEL_OUTPUT_DIR}')
    print('---------------------------------------------')


# ── Main ───────────────────────────────────────────────────────────────────
def main():
    print('===========================================')
    print('  Quick Draw Model Trainer (Python)')
    print(f'  Categories: {", ".join(CATEGORIES)}')
    print('===========================================')
    print(f'\nTensorFlow version: {tf.__version__}')

    x_train, y_train, x_val, y_val = load_data()
    model = build_model()
    train_model(model, x_train, y_train, x_val, y_val)
    quick_validate(model, x_val, y_val)
    save_model(model)


if __name__ == '__main__':
    main()