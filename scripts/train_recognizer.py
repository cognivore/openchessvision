#!/usr/bin/env python3
"""
Train a CNN for chess piece recognition.

PyTorch implementation of the linrock/chessboard-recognizer CNN architecture
with additional data augmentation and training improvements.
"""

import os
import argparse
import random
from pathlib import Path
from glob import glob

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import Dataset, DataLoader
from torchvision import transforms
from PIL import Image

# FEN characters (class labels)
FEN_CHARS = '1RNBQKPrnbqkp'
NUM_CLASSES = len(FEN_CHARS)

# Default paths
TILES_DIR = Path('./data/tiles')
MODEL_DIR = Path('./models')
MODEL_PATH = MODEL_DIR / 'chess_recognizer.pt'


class ChessTileDataset(Dataset):
    """Dataset of chess tile images with piece labels."""

    def __init__(
        self,
        tiles_dir: Path,
        transform=None,
        use_grayscale: bool = True
    ):
        self.tiles_dir = Path(tiles_dir)
        self.transform = transform
        self.use_grayscale = use_grayscale

        # Find all tile images
        self.samples = []

        # Look for tiles in by_class directory structure only
        # This avoids loading duplicates from both nested dirs and by_class
        patterns = [
            str(self.tiles_dir / 'by_class/*/*.png'),  # tiles/by_class/piece/tile.png
        ]

        # Fall back to nested structure if by_class doesn't exist
        if not list(glob(patterns[0])):
            patterns = [
                str(self.tiles_dir / '*/*/*.png'),  # tiles/source/board/tile.png
            ]

        for pattern in patterns:
            for filepath in glob(pattern):
                filepath = Path(filepath)

                # Extract label from filename (e.g., "prefix_a8_R.png" -> "R")
                # Always use filename, not directory (macOS filesystem is case-insensitive)
                label = filepath.stem.split('_')[-1]

                if label in FEN_CHARS:
                    label_idx = FEN_CHARS.index(label)
                    self.samples.append((filepath, label_idx))

        if not self.samples:
            raise ValueError(f"No valid samples found in {tiles_dir}")

        print(f"Loaded {len(self.samples)} tile samples")

        # Count class distribution
        class_counts = {}
        for _, label_idx in self.samples:
            char = FEN_CHARS[label_idx]
            class_counts[char] = class_counts.get(char, 0) + 1

        print("Class distribution:")
        for char in FEN_CHARS:
            count = class_counts.get(char, 0)
            print(f"  {char}: {count} ({100*count/len(self.samples):.1f}%)")

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        filepath, label = self.samples[idx]

        # Load image
        img = Image.open(filepath)

        if self.use_grayscale:
            img = img.convert('L')
        else:
            img = img.convert('RGB')

        if self.transform:
            img = self.transform(img)

        return img, label


class ChessCNN(nn.Module):
    """CNN for chess piece classification.

    Architecture matches linrock/chessboard-recognizer:
    Conv2D(32, 3x3) -> MaxPool -> Conv2D(64, 3x3) -> MaxPool ->
    Conv2D(64, 3x3) -> Flatten -> Dense(64) -> Dense(13)
    """

    def __init__(self, num_classes: int = NUM_CLASSES, in_channels: int = 1):
        super().__init__()

        self.features = nn.Sequential(
            # Block 1: Conv -> ReLU -> MaxPool
            nn.Conv2d(in_channels, 32, kernel_size=3, padding=1),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(kernel_size=2, stride=2),  # 32x32 -> 16x16

            # Block 2: Conv -> ReLU -> MaxPool
            nn.Conv2d(32, 64, kernel_size=3, padding=1),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(kernel_size=2, stride=2),  # 16x16 -> 8x8

            # Block 3: Conv -> ReLU
            nn.Conv2d(64, 64, kernel_size=3, padding=1),
            nn.ReLU(inplace=True),
            # Note: linrock doesn't have a third maxpool, resulting in 8x8x64 = 4096
            # But TF tutorial has it, resulting in 4x4x64 = 1024
            # Let's match TF tutorial for consistency
            nn.MaxPool2d(kernel_size=2, stride=2),  # 8x8 -> 4x4
        )

        # Classifier
        self.classifier = nn.Sequential(
            nn.Flatten(),
            nn.Linear(64 * 4 * 4, 64),  # 1024 -> 64
            nn.ReLU(inplace=True),
            nn.Dropout(0.5),
            nn.Linear(64, num_classes),
        )

    def forward(self, x):
        x = self.features(x)
        x = self.classifier(x)
        return x


def get_transforms(augment: bool = True, grayscale: bool = True):
    """Get image transforms for training/testing."""

    if augment:
        transform = transforms.Compose([
            transforms.Resize((32, 32)),
            transforms.RandomRotation(5),
            transforms.RandomAffine(
                degrees=0,
                translate=(0.05, 0.05),
                scale=(0.95, 1.05),
            ),
            transforms.ColorJitter(
                brightness=0.2,
                contrast=0.2,
            ),
            transforms.ToTensor(),
            transforms.Normalize(mean=[0.5], std=[0.5]) if grayscale else
                transforms.Normalize(mean=[0.5, 0.5, 0.5], std=[0.5, 0.5, 0.5]),
        ])
    else:
        transform = transforms.Compose([
            transforms.Resize((32, 32)),
            transforms.ToTensor(),
            transforms.Normalize(mean=[0.5], std=[0.5]) if grayscale else
                transforms.Normalize(mean=[0.5, 0.5, 0.5], std=[0.5, 0.5, 0.5]),
        ])

    return transform


def train_epoch(model, dataloader, criterion, optimizer, device):
    """Train for one epoch."""
    model.train()
    running_loss = 0.0
    correct = 0
    total = 0

    for images, labels in dataloader:
        images = images.to(device)
        labels = labels.to(device)

        optimizer.zero_grad()
        outputs = model(images)
        loss = criterion(outputs, labels)
        loss.backward()
        optimizer.step()

        running_loss += loss.item() * images.size(0)
        _, predicted = outputs.max(1)
        total += labels.size(0)
        correct += predicted.eq(labels).sum().item()

    epoch_loss = running_loss / total
    epoch_acc = correct / total
    return epoch_loss, epoch_acc


def evaluate(model, dataloader, criterion, device):
    """Evaluate model on a dataset."""
    model.eval()
    running_loss = 0.0
    correct = 0
    total = 0

    with torch.no_grad():
        for images, labels in dataloader:
            images = images.to(device)
            labels = labels.to(device)

            outputs = model(images)
            loss = criterion(outputs, labels)

            running_loss += loss.item() * images.size(0)
            _, predicted = outputs.max(1)
            total += labels.size(0)
            correct += predicted.eq(labels).sum().item()

    epoch_loss = running_loss / total
    epoch_acc = correct / total
    return epoch_loss, epoch_acc


def train(
    tiles_dir: Path,
    model_path: Path,
    epochs: int = 30,
    batch_size: int = 64,
    learning_rate: float = 0.001,
    train_ratio: float = 0.85,
    use_grayscale: bool = True,
    augment: bool = True,
):
    """Train the chess piece recognition model."""

    device = torch.device('cuda' if torch.cuda.is_available() else
                          'mps' if torch.backends.mps.is_available() else 'cpu')
    print(f"Using device: {device}")

    # Create dataset
    transform_train = get_transforms(augment=augment, grayscale=use_grayscale)
    transform_test = get_transforms(augment=False, grayscale=use_grayscale)

    full_dataset = ChessTileDataset(
        tiles_dir,
        transform=None,  # Apply transform later
        use_grayscale=use_grayscale
    )

    # Split into train/test
    n_samples = len(full_dataset)
    indices = list(range(n_samples))
    random.seed(42)
    random.shuffle(indices)

    split = int(n_samples * train_ratio)
    train_indices = indices[:split]
    test_indices = indices[split:]

    # Create subset datasets with different transforms
    class SubsetDataset(Dataset):
        def __init__(self, base_dataset, indices, transform):
            self.base = base_dataset
            self.indices = indices
            self.transform = transform

        def __len__(self):
            return len(self.indices)

        def __getitem__(self, idx):
            filepath, label = self.base.samples[self.indices[idx]]
            img = Image.open(filepath)
            if self.base.use_grayscale:
                img = img.convert('L')
            else:
                img = img.convert('RGB')
            if self.transform:
                img = self.transform(img)
            return img, label

    train_dataset = SubsetDataset(full_dataset, train_indices, transform_train)
    test_dataset = SubsetDataset(full_dataset, test_indices, transform_test)

    print(f"Training samples: {len(train_dataset)}")
    print(f"Test samples: {len(test_dataset)}")

    train_loader = DataLoader(
        train_dataset, batch_size=batch_size, shuffle=True, num_workers=0
    )
    test_loader = DataLoader(
        test_dataset, batch_size=batch_size, shuffle=False, num_workers=0
    )

    # Create model
    in_channels = 1 if use_grayscale else 3
    model = ChessCNN(num_classes=NUM_CLASSES, in_channels=in_channels)
    model = model.to(device)

    # Calculate class weights (to handle imbalanced empty squares)
    class_counts = {}
    for _, label_idx in full_dataset.samples:
        class_counts[label_idx] = class_counts.get(label_idx, 0) + 1

    total = sum(class_counts.values())
    class_weights = torch.tensor([
        total / (NUM_CLASSES * class_counts.get(i, 1))
        for i in range(NUM_CLASSES)
    ], dtype=torch.float32).to(device)

    criterion = nn.CrossEntropyLoss(weight=class_weights)
    optimizer = optim.Adam(model.parameters(), lr=learning_rate)
    scheduler = optim.lr_scheduler.ReduceLROnPlateau(
        optimizer, mode='min', factor=0.5, patience=3
    )

    # Training loop
    best_acc = 0.0
    for epoch in range(epochs):
        train_loss, train_acc = train_epoch(
            model, train_loader, criterion, optimizer, device
        )
        test_loss, test_acc = evaluate(
            model, test_loader, criterion, device
        )

        scheduler.step(test_loss)

        print(f"Epoch {epoch+1}/{epochs}")
        print(f"  Train Loss: {train_loss:.4f}, Train Acc: {train_acc:.4f}")
        print(f"  Test Loss:  {test_loss:.4f}, Test Acc:  {test_acc:.4f}")

        # Save best model
        if test_acc > best_acc:
            best_acc = test_acc
            model_path.parent.mkdir(parents=True, exist_ok=True)
            torch.save({
                'model_state_dict': model.state_dict(),
                'optimizer_state_dict': optimizer.state_dict(),
                'epoch': epoch,
                'test_acc': test_acc,
                'fen_chars': FEN_CHARS,
                'use_grayscale': use_grayscale,
            }, model_path)
            print(f"  Saved best model (acc: {test_acc:.4f})")

    print(f"\nTraining complete. Best test accuracy: {best_acc:.4f}")
    print(f"Model saved to: {model_path}")

    return best_acc


def main():
    parser = argparse.ArgumentParser(
        description="Train chess piece recognition CNN"
    )
    parser.add_argument(
        "--input", "-i", type=Path, default=TILES_DIR,
        help=f"Input directory with tile images (default: {TILES_DIR})"
    )
    parser.add_argument(
        "--output", "-o", type=Path, default=MODEL_PATH,
        help=f"Output model path (default: {MODEL_PATH})"
    )
    parser.add_argument(
        "--epochs", "-e", type=int, default=30,
        help="Number of training epochs (default: 30)"
    )
    parser.add_argument(
        "--batch-size", "-b", type=int, default=64,
        help="Batch size (default: 64)"
    )
    parser.add_argument(
        "--lr", type=float, default=0.001,
        help="Learning rate (default: 0.001)"
    )
    parser.add_argument(
        "--no-augment", action="store_true",
        help="Disable data augmentation"
    )
    parser.add_argument(
        "--color", action="store_true",
        help="Use color images instead of grayscale"
    )

    args = parser.parse_args()

    train(
        tiles_dir=args.input,
        model_path=args.output,
        epochs=args.epochs,
        batch_size=args.batch_size,
        learning_rate=args.lr,
        use_grayscale=not args.color,
        augment=not args.no_augment,
    )


if __name__ == "__main__":
    main()
