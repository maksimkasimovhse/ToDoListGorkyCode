"""Read the user-provided credential sheet without third-party XLSX packages."""

from __future__ import annotations

from pathlib import Path
from xml.etree import ElementTree
from zipfile import ZipFile


NS = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def read_credentials(path: str | Path) -> tuple[str, str]:
    with ZipFile(path) as archive:
        strings = [
            "".join(node.text or "" for node in item.findall(".//x:t", NS))
            for item in ElementTree.fromstring(archive.read("xl/sharedStrings.xml")).findall("x:si", NS)
        ]
        sheet = ElementTree.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        cells = {}
        for cell in sheet.findall(".//x:sheetData/x:row/x:c", NS):
            value = cell.find("x:v", NS)
            if cell.get("t") == "s" and value is not None and value.text:
                cells[cell.get("r")] = strings[int(value.text)].strip()
    if cells.get("C1") != "Authorization Key" or cells.get("F1") != "Scope":
        raise ValueError("В XLSX не найдены колонки Authorization Key и Scope")
    key, scope = cells.get("C2"), cells.get("F2")
    if not key or scope not in {"GIGACHAT_API_PERS", "GIGACHAT_API_B2B", "GIGACHAT_API_CORP"}:
        raise ValueError("В XLSX отсутствует ключ или задан неизвестный Scope")
    return key, scope
