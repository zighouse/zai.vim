import tiktoken
from transformers import AutoTokenizer

class AITokenizer:
    def __init__(self):
        self._encoders = {}

    def encode(self, text: str, tokenizer: str = None, by_default = True) -> list:
        """Encode the text according to the name of tokenizer, or by default(cl100k_base)"""
        enc = tiktoken.get_encoding("cl100k_base") if by_default else None
        if tokenizer:
            if tokenizer in self._encoders:
                enc = self._encoders[tokenizer]
            else:
                try:
                    if '/' in tokenizer:
                        enc = AutoTokenizer.from_pretrained(tokenizer, trust_remote_code=True)
                    else:
                        enc = tiktoken.encoding_for_model(tokenizer)
                    if enc:
                        self._encoders[tokenizer] = enc
                except:
                    if by_default:
                        enc = tiktoken.get_encoding("cl100k_base")
        if enc:
            return enc.encode(text, add_special_tokens=False)
        return []

    def count_tokens(self, tokenizer: str, text: str, by_default = True) -> int:
        return len(self.encode(tokenizer, text, by_default))
