import re
import tiktoken
from transformers import AutoTokenizer

class _DummyEncoder:
    def encode(self, text: str) -> list:
        return []

class AITokenizer:
    def __init__(self):
        self._encoders = {}
        self._fails = {}

    def _normalize_model_name(self, model_name: str) -> str:
        normalized = re.sub(r'(-GPTQ|-AWQ|-GGUF|-GGML|-INT4|-INT8|-fp16)|(-v\d+)$', '', model_name)
        return normalized.strip()

    def _get_default_encoder(self):
        try:
            if "cl100k_base" in self._encoders:
                return self._encoders["cl100k_base"];
            enc = tiktoken.get_encoding("cl100k_base")
            self._encoders["cl100k_base"] = enc
            return enc
        except:
            return _DummyEncoder()

    def _get_encoder(self, model_name: str):
        normalized_name = self._normalize_model_name(model_name)
        if normalized_name in self._encoders:
            return self._encoders[normalized_name]
        if normalized_name in self._fails:
            return self._get_default_encoder()
        try:
            if model_name in tiktoken.model.MODEL_TO_ENCODING:
                enc = tiktoken.encoding_for_model(model_name)
                self._encoders[normalized_name] = enc
                return enc
            enc = AutoTokenizer.from_pretrained(
                model_name,
                local_files_only=True,
                trust_remote_code=False,
                use_fast=True
            )
            self._encoders[normalized_name] = enc
            return enc
        except Exception as e:
            self._fails[normalized_name] = True
            return self._get_default_encoder()

    def encode(self, text: str, model_name = None) -> list:
        if not text:
            return []

        if not model_name or model_name == "cl100k_base":
            enc = self._get_default_encoder()
            return enc.encode(text)

        enc = self._get_encoder(model_name)
        return enc.encode(text)

    def count_tokens(self, text: str, model_name = None) -> int:
        return len(self.encode(text, model_name))

    def truncate_by_tokens(self, text: str, model_name: str, max_tokens: int) -> str:
        enc = self._get_encoder(model_name)
        if not enc or isinstance(enc, _DummyEncoder):
            return text

        tokens = self.encode(text, model_name)
        if len(tokens) <= max_tokens:
            return text

        truncated_tokens = tokens[:max_tokens]
        return enc.decode(truncated_tokens)
