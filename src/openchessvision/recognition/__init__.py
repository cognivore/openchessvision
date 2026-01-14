"""Chess diagram recognition backends."""

from openchessvision.recognition.classical import ClassicalRecognitionBackend
from openchessvision.recognition.ml import MLXRecognitionBackend
from openchessvision.recognition.vision_llm import VisionLLMBackend, create_vision_backend
from openchessvision.recognition.local_cnn import LocalCNNBackend
from openchessvision.recognition.linrock_cnn import LinrockCNNBackend

__all__ = [
    "ClassicalRecognitionBackend",
    "MLXRecognitionBackend",
    "VisionLLMBackend",
    "create_vision_backend",
    "LocalCNNBackend",
    "LinrockCNNBackend",
]
