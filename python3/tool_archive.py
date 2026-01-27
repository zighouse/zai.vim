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
        return "[严格规则] 历史对话中的长内容已被压缩为\"归档引用\"。\n" + \
               "1. \"归档引用\"内的文本仅仅是摘要或预览，并不完整。\n" + \
               "2. **绝不要**直接引用\"归档引用\"内不完整的片段作为事实依据。\n" + \
               "3. 必须调用 fetch_archive 工具获得完整归档内容后，才能将其作为真实数据使用。\n" + \
               "4. 若用户询问历史细节，**必须**先识别出所有相关的归档引用，然后调用 fetch_archive，禁止基于预览进行猜测。\n" + \
               "5. 对于大型归档文件，可以使用分页参数（page_type, page_size, page_number）分段读取。"
    else:
        #self._prompt_for_archive = "Archives are represented as ‹archive id=ID›...‹/archive›. " + \
        #        "If you need to read an archive's full content to answer, reply with exactly " + \
        #        "the line: FETCH_ARCHIVE {ID} and nothing else. " + \
        #        "The client will then provide the archive content and you should continue the answer."
        #return "归档文件以 ‹archive id=ID›...‹/archive› 的形式表示。" + \
        #        "如果你需要读取归档文件的完整内容来回答问题，请准确回复以下行：" + \
        #        "FETCH_ARCHIVE {ID}，且不要包含其他任何内容。" + \
        #        "客户端随后将提供归档内容，你应继续完成回答。"
        return "因为内容过长，所以使用\"归档引用\"告知已经归档的内容。" + \
                "若要获取准确数据，请回复 FETCH_ARCHIVE {ID}。"

def invoke_fetch_archive(archive_file: str,
                        page_type: str = "line",
                        page_size: int = None,
                        page_number: int = None) -> str:
    """
    读取归档文件，支持分页

    参数:
        archive_file: 归档文件名
        page_type: 分页类型，'line' 按行数分页，'length' 按字符长度分页
        page_size: 每页大小（行数或字符数）
        page_number: 页码（从1开始）

    返回:
        归档文件内容（分页或全部）
    """
    global _config
    archive_dir = _config.get('archive_dir', '/tmp/zai.archive')
    filepath = os.path.join(archive_dir, f"{archive_file}")
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            long_content = f.read()

        # 如果没有指定分页参数，返回全部内容
        if page_size is None or page_number is None:
            return long_content

        # 参数校验
        if page_number < 1:
            return f"错误：页码必须大于等于1，当前值为 {page_number}"
        if page_size < 1:
            return f"错误：页大小必须大于等于1，当前值为 {page_size}"

        # 按行数分页
        if page_type == "line":
            lines = long_content.split('\n')
            total_lines = len(lines)
            total_pages = (total_lines + page_size - 1) // page_size

            if page_number > total_pages:
                return f"错误：页码超出范围。文件共有 {total_lines} 行，每页 {page_size} 行，共 {total_pages} 页，请求的是第 {page_number} 页。"

            start_idx = (page_number - 1) * page_size
            end_idx = min(start_idx + page_size, total_lines)
            page_content = '\n'.join(lines[start_idx:end_idx])

            header = f"==========\n[分页内容]\n" \
                     f"- 归档文件:{archive_file}\n" \
                     f"- 分页类型:按行数\n" \
                     f"- 当前页:{page_number}/{total_pages}\n" \
                     f"- 每页行数:{page_size}\n" \
                     f"- 总行数:{total_lines}\n" \
                     f"============\n\n"

            return header + page_content

        # 按字符长度分页
        elif page_type == "length":
            total_length = len(long_content)
            total_pages = (total_length + page_size - 1) // page_size

            if page_number > total_pages:
                return f"错误：页码超出范围。文件共有 {total_length} 字符，每页 {page_size} 字符，共 {total_pages} 页，请求的是第 {page_number} 页。"

            start_idx = (page_number - 1) * page_size
            end_idx = min(start_idx + page_size, total_length)
            page_content = long_content[start_idx:end_idx]

            header = f"==========\n[分页内容]\n" \
                     f"- 归档文件:{archive_file}\n" \
                     f"- 分页类型:按字符长度\n" \
                     f"- 当前页:{page_number}/{total_pages}\n" \
                     f"- 每页字符数:{page_size}\n" \
                     f"- 总字符数:{total_length}\n" \
                     f"============\n\n"

            return header + page_content

        else:
            return f"错误：不支持的分页类型 '{page_type}'，支持的类型为 'line' 或 'length'。"

    except FileNotFoundError:
        return f"读取归档文件失败：文件 `{archive_file}` 不存在。"
    except Exception as e:
        return f"读取归档文件 `{archive_file}` 失败：{e}"
