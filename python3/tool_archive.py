import os

_config = {}

def set_config(config : dict):
    global _config
    _config = config

def get_prompt(with_tool_call: bool) -> str:
    if with_tool_call:
        #return "归档文件以 ‹archive id=ID›...‹/archive› 的形式表示。" + \
        #        "如果你需要读取归档文件的完整内容来回答问题，请调用 fetch_archive 工具，" + \
        #        "在客户端提供归档内容后，你应继续完成回答。"
        return "[严格规则] 历史对话中的长内容已被压缩为形如 ‹archive id=ID›...‹/archive› 的标签。\n" + \
               "1. 标签内部的文本仅仅是摘要或预览，可能不完整、不准确。\n" + \
               "2. **绝不要**直接引用标签内的具体数值、时间戳或代码片段作为事实依据，也不要据此进行计算。\n" + \
               "3. 只有调用 fetch_archive 工具获取到完整归档内容后，才能将其作为真实数据使用。\n" + \
               "4. 若用户询问历史细节，**必须**先调用 fetch_archive，禁止基于预览进行猜测。"
    else:
        #self._prompt_for_archive = "Archives are represented as ‹archive id=ID›...‹/archive›. " + \
        #        "If you need to read an archive's full content to answer, reply with exactly " + \
        #        "the line: FETCH_ARCHIVE {ID} and nothing else. " + \
        #        "The client will then provide the archive content and you should continue the answer."
        #return "归档文件以 ‹archive id=ID›...‹/archive› 的形式表示。" + \
        #        "如果你需要读取归档文件的完整内容来回答问题，请准确回复以下行：" + \
        #        "FETCH_ARCHIVE {ID}，且不要包含其他任何内容。" + \
        #        "客户端随后将提供归档内容，你应继续完成回答。"
        return "归档文件以 ‹archive id=ID›...‹/archive› 的形式表示。" + \
                "若要获取准确数据，请回复 FETCH_ARCHIVE {ID}。"

def invoke_fetch_archive(archive_file: str) -> str:
    global _config
    archive_dir = _config.get('archive_dir', '/tmp/zai.archive')
    filepath = os.path.join(archive_dir, f"{archive_file}")
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            long_content = f.read()
        return long_content
    except:
        return f"读取归档文件`{archive_file}`失败。"

