"""
train_model.py
Train a CNN on Quick Draw .npy data and save as Keras .h5 format.

Usage:
    python scripts/train_model.py
"""

import os
import numpy as np
import tensorflow as tf

# ── Config ─────────────────────────────────────────────────────────────────
CATEGORIES = [
    'cat', 'dog', 'house', 'sun', 'tree', 'fish', 'star',
    'car', 'airplane', 'umbrella', 'guitar', 'clock', 'flower', 'bicycle',
    'elephant', 'penguin', 'crown', 'lighthouse', 'snowflake', 'cactus',
]

DATA_DIR         = os.path.join(os.path.dirname(__file__), 'data')
H5_OUTPUT_PATH   = os.path.join(os.path.dirname(__file__), 'quickdraw_model.h5')
MODEL_OUTPUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'assets', 'model')

SAMPLES_PER_CLASS = 15000
TRAIN_SPLIT       = 0.8
BATCH_SIZE        = 256
EPOCHS            = 15
IMAGE_SIZE        = 28
# ───────────────────────────────────────────────────────────────────────────


# ── Step 1: Load .npy files ─────────────────────────────────────────────────
def load_data():
    print('\nLoading data...')
    all_images = []
    all_labels = []

    for class_idx, category in enumerate(CATEGORIES):
        file_path = os.path.join(DATA_DIR, f'{category}.npy')

        if not os.path.exists(file_path):
            print(f'\nERROR: File not found: {file_path}')
            exit(1)

        print(f'  [{class_idx+1:2d}/{len(CATEGORIES)}] {category}')
        data  = np.load(file_path)
        n     = min(SAMPLES_PER_CLASS, data.shape[0])

        samples = 1.0 - data[:n].astype('float32') / 255.0
        samples = samples.reshape(n, IMAGE_SIZE, IMAGE_SIZE, 1)

        all_images.append(samples)
        all_labels.extend([class_idx] * n)

    x = np.concatenate(all_images, axis=0)
    y = np.array(all_labels)

    print(f'\n  Total samples: {len(y)}')

    indices = np.random.permutation(len(y))
    x, y    = x[indices], y[indices]

    y = tf.keras.utils.to_categorical(y, num_classes=len(CATEGORIES))

    split       = int(len(x) * TRAIN_SPLIT)
    x_train, x_val = x[:split], x[split:]
    y_train, y_val = y[:split], y[split:]

    print(f'  Train: {len(x_train)}, Val: {len(x_val)}')
    return x_train, y_train, x_val, y_val


# ── Step 2: Build CNN ────────────────────────────────────────────────────────
def build_model():
    print('\nBuilding CNN model...')

    model = tf.keras.Sequential([
        # Block 1
        tf.keras.layers.Conv2D(32, (3, 3), activation='relu', padding='same',
                               input_shape=(IMAGE_SIZE, IMAGE_SIZE, 1)),
        tf.keras.layers.Conv2D(32, (3, 3), activation='relu', padding='same'),
        tf.keras.layers.MaxPooling2D((2, 2)),
        tf.keras.layers.Dropout(0.25),

        # Block 2
        tf.keras.layers.Conv2D(64, (3, 3), activation='relu', padding='same'),
        tf.keras.layers.Conv2D(64, (3, 3), activation='relu', padding='same'),
        tf.keras.layers.MaxPooling2D((2, 2)),
        tf.keras.layers.Dropout(0.25),

        # Block 3
        tf.keras.layers.Conv2D(128, (3, 3), activation='relu', padding='same'),
        tf.keras.layers.MaxPooling2D((2, 2)),
        tf.keras.layers.Dropout(0.25),

        # Classifier
        tf.keras.layers.Flatten(),
        tf.keras.layers.Dense(256, activation='relu'),
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


# ── Step 3: Train ────────────────────────────────────────────────────────────
def train_model(model, x_train, y_train, x_val, y_val):
    print(f'\nTraining ({EPOCHS} epochs, batch {BATCH_SIZE})...\n')

    callbacks = [
        # Reduce LR when val_accuracy plateaus
        tf.keras.callbacks.ReduceLROnPlateau(
            monitor='val_accuracy', factor=0.5,
            patience=3, min_lr=1e-5, verbose=1
        ),
        # Stop early if no improvement for 5 epochs
        tf.keras.callbacks.EarlyStopping(
            monitor='val_accuracy', patience=5,
            restore_best_weights=True, verbose=1
        ),
    ]

    history = model.fit(
        x_train, y_train,
        epochs=EPOCHS,
        batch_size=BATCH_SIZE,
        validation_data=(x_val, y_val),
        callbacks=callbacks,
        verbose=1,
    )

    final_acc     = history.history['accuracy'][-1]
    final_val_acc = history.history['val_accuracy'][-1]
    print(f'\nTraining complete.')
    print(f'  Final accuracy:     {final_acc * 100:.1f}%')
    print(f'  Final val accuracy: {final_val_acc * 100:.1f}%')


# ── Step 4: Quick validation ─────────────────────────────────────────────────
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
        print(f'  [{i+1}] predicted: {pred:<12} actual: {truth:<12} {mark}')
        if pred == truth:
            correct += 1

    print(f'\n  Result: {correct}/10 correct')


# ── Step 5: Save .h5 ─────────────────────────────────────────────────────────
def save_model(model):
    model.save(H5_OUTPUT_PATH)
    print(f'\nModel saved: {H5_OUTPUT_PATH}')
    print('\nNext step: run convert_model.py to convert to TF.js format')


# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    print('=' * 50)
    print('  Quick Draw Model Trainer')
    print(f'  {len(CATEGORIES)} categories, {SAMPLES_PER_CLASS} samples each')
    print('=' * 50)
    print(f'TensorFlow: {tf.__version__}')

    x_train, y_train, x_val, y_val = load_data()
    model = build_model()
    train_model(model, x_train, y_train, x_val, y_val)
    quick_validate(model, x_val, y_val)
    save_model(model)


if __name__ == '__main__':
    main()