"""Chess diagram recognition backends."""

from openchessvision.recognition.classical import ClassicalRecognitionBackend
from openchessvision.recognition.ml import MLXRecognitionBackend

__all__ = [
    "ClassicalRecognitionBackend",
    "MLXRecognitionBackend",
]
