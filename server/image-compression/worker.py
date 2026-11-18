"""Private, bounded image compression. Never extracts user paths to disk."""
import csv
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tempfile
import warnings
import zipfile

FORMATS = {'.png': 'PNG', '.jpg': 'JPEG', '.jpeg': 'JPEG', '.webp': 'WEBP'}
MAX_FILES = 500
MAX_BYTES = 200 * 1024 * 1024
MAX_PIXELS = 16_000_000


def capabilities():
    missing = []
    try:
        from PIL import Image, features
        if not features.check("webp"):
            missing.append("Pillow WebP 解码器")
    except ImportError:
        missing.append('Pillow')
    for name in ('oxipng', 'cwebp', 'jpegtran'):
        command = os.environ.get('IMAGE_' + name.upper(), name)
        if not shutil.which(command):
            missing.append(name)
            continue
        try:
            probe = subprocess.run([command, '--version' if name == 'oxipng' else '-version'],
                                   capture_output=True, timeout=3)
            if probe.returncode != 0:
                missing.append(name + '（无法启动，请检查动态库）')
        except (OSError, subprocess.TimeoutExpired):
            missing.append(name + '（无法启动）')
    return {'ready': not missing, 'missing': missing}


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def safe_name(name):
    parts = name.split('/')
    if (not name or name.startswith('/') or '\\' in name or ':' in name
            or any(p in ('', '.', '..') for p in parts)
            or any(ord(c) < 32 for c in name) or len(name) > 500):
        raise ValueError('ZIP 包含不安全或过长的文件路径')
    return name


def inputs(source):
    if zipfile.is_zipfile(source):
        with zipfile.ZipFile(source) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_FILES * 3:
                raise ValueError('ZIP 条目过多')
            selected, names, total = [], set(), 0
            for entry in entries:
                if entry.is_dir():
                    continue
                name = safe_name(entry.filename)
                if name.startswith('__MACOSX/') or PurePosixPath(name).name == '.DS_Store':
                    continue
                if PurePosixPath(name).suffix.lower() not in FORMATS:
                    raise ValueError('ZIP 仅支持 PNG、JPG、JPEG、WebP 图片，请移除其他类型文件后重试')
                if name.casefold() in names:
                    raise ValueError('ZIP 包含同名图片，请先消除重名')
                names.add(name.casefold())
                if entry.flag_bits & 1 or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError('不支持加密 ZIP 或符号链接')
                total += entry.file_size
                if total > MAX_BYTES or len(selected) >= MAX_FILES:
                    raise ValueError('最多 500 张图片，解压后合计不超过 200 MiB')
                selected.append(entry)
            if not selected:
                raise ValueError('ZIP 中没有支持的图片')
            for entry in selected:
                # Read no more than the remaining per-archive budget, even for malformed ZIPs.
                with archive.open(entry) as stream:
                    data = stream.read(min(entry.file_size, MAX_BYTES) + 1)
                if len(data) != entry.file_size:
                    raise ValueError('ZIP 文件长度异常')
                yield entry.filename, data, len(selected)
    else:
        name = safe_name((source.parent / 'name.txt').read_text())
        yield name, source.read_bytes(), 1


def rgba(data):
    from PIL import Image
    with Image.open(io.BytesIO(data)) as image:
        return image.size, image.convert('RGBA').tobytes()


def converted_name(name, reserved):
    candidate = str(PurePosixPath(name).with_suffix('.webp'))
    suffix = 0
    while candidate.casefold() in reserved:
        suffix += 1
        candidate = name + ('' if suffix == 1 else '.' + str(suffix)) + '.webp'
    reserved.add(candidate.casefold())
    return candidate


def run(directory):
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    warnings.simplefilter('error', Image.DecompressionBombWarning)
    folder = Path(directory)
    rows, duplicates, pixels = [], {}, 0
    # Reserve every original name before generating converted names. Otherwise
    # icon.png -> icon.webp can overwrite a later original icon.webp in a ZIP.
    if zipfile.is_zipfile(folder / 'input'):
        with zipfile.ZipFile(folder / 'input') as archive:
            reserved = {entry.filename.casefold() for entry in archive.infolist()}
    else:
        reserved = {(folder / 'name.txt').read_text().casefold()}
    archives = {key: zipfile.ZipFile(folder / (key + '.zip'), 'w', zipfile.ZIP_DEFLATED, compresslevel=9)
                for key in ('png', 'webp', 'smallest')}
    try:
        for index, (name, original, count) in enumerate(inputs(folder / 'input')):
            with Image.open(io.BytesIO(original)) as image:
                fmt = image.format
                if FORMATS.get(PurePosixPath(name).suffix.lower()) != fmt:
                    raise ValueError('图片内容与扩展名不匹配或格式不支持：' + name)
                width, height = image.size
                pixels += width * height
                if width * height > MAX_PIXELS or pixels > 150_000_000:
                    raise ValueError('图片像素总量过大，请分批上传')
                animated = getattr(image, 'n_frames', 1) > 1
                # Conservatively retain display metadata and high bit depth. RGBA
                # equality alone cannot prove ICC/EXIF/CMYK display equivalence.
                preserve = image.mode not in ('RGB', 'RGBA', 'P', 'L', 'LA', '1') or any(
                    image.info.get(key) for key in ('icc_profile', 'exif', 'xmp', 'XML:com.adobe.xmp', 'gamma', 'chromaticity'))
                preserve = preserve or (fmt == 'PNG' and original[24] == 16)
                if not animated and not preserve:
                    image.convert('RGBA').save(folder / 'decoded.png')
            source = folder / 'source.image'
            source.write_bytes(original)
            note = '动画图片保留原文件，未重编码' if animated else ''
            kept, webp, webp_name = original, original, name
            if not animated:
                reference = rgba(original)
                if fmt == 'PNG':
                    optimized = folder / 'optimized.png'
                    optimized.write_bytes(original)
                    subprocess.run([os.environ.get('IMAGE_OXIPNG', 'oxipng'), '-o', '6', '--strip', 'safe', str(optimized)],
                                   check=True, capture_output=True, timeout=90)
                    subprocess.run([os.environ.get('IMAGE_OXIPNG', 'oxipng'), '-o', '6', '-z', '--zi', '60',
                                    '--ziwi', '10', '--fast', '--strip', 'safe', str(optimized)],
                                   check=True, capture_output=True, timeout=90)
                    candidate = optimized.read_bytes()
                    if rgba(candidate) == reference and len(candidate) < len(kept):
                        kept = candidate
                elif fmt == 'JPEG':
                    # Optimize DCT coefficients, never decode/re-encode JPEG pixels.
                    for progressive in ([], ['-progressive']):
                        optimized = folder / 'optimized.jpg'
                        subprocess.run([os.environ.get('IMAGE_JPEGTRAN', 'jpegtran'), '-copy', 'all', '-optimize',
                                        *progressive, '-outfile', str(optimized), str(source)],
                                       check=True, capture_output=True, timeout=90)
                        candidate = optimized.read_bytes()
                        if rgba(candidate) == reference and len(candidate) < len(kept):
                            kept = candidate
                if preserve:
                    note = '保留色彩/方向元数据或高位深，不转换 WebP'
                    if fmt == 'WEBP':
                        note = '保留色彩/方向元数据，使用原 WebP'
                else:
                    encoded = folder / 'encoded.webp'
                    subprocess.run([os.environ.get('IMAGE_CWEBP', 'cwebp'), '-z', '9', '-exact', '-metadata', 'all',
                                    str(folder / 'decoded.png'), '-o', str(encoded)],
                                   check=True, capture_output=True, timeout=90)
                    candidate = encoded.read_bytes()
                    if rgba(candidate) != reference:
                        raise ValueError('WebP 像素校验未通过：' + name)
                    if len(candidate) < len(original):
                        webp = candidate
                        webp_name = name if fmt == 'WEBP' else converted_name(name, reserved)
                    else:
                        note = 'WebP 未变小，保留原文件'
                    if fmt == 'WEBP':
                        kept = webp
                digest = hashlib.sha256(str(reference[0]).encode() + reference[1]).hexdigest()
                duplicates.setdefault(digest, []).append(name)
            smallest, smallest_name = (webp, webp_name) if len(webp) < len(kept) else (kept, name)
            # The png key is retained for compatibility; it now means original format.
            for key, output_name, data in [('png', name, kept), ('webp', webp_name, webp), ('smallest', smallest_name, smallest)]:
                archives[key].writestr(output_name, data)
            rows.append({'name': name, 'format': fmt, 'width': width, 'height': height, 'originalBytes': len(original),
                         'pngBytes': len(kept), 'webpBytes': len(webp), 'smallestBytes': len(smallest),
                         'webpName': webp_name, 'outputName': smallest_name, 'verified': not animated, 'note': note})
            emit({'completed': index + 1, 'total': count})
    finally:
        for archive in archives.values():
            archive.close()
    summary = {'count': len(rows), 'originalBytes': sum(r['originalBytes'] for r in rows),
               'verifiedCount': sum(r['verified'] for r in rows),
               'duplicates': [group for group in duplicates.values() if len(group) > 1], 'rows': rows,
               'variants': {key: {'bytes': sum(r[key + 'Bytes'] for r in rows),
                                  'zipBytes': (folder / (key + '.zip')).stat().st_size}
                            for key in archives}}
    (folder / 'report.json').write_text(json.dumps(summary, ensure_ascii=False), encoding='utf-8')
    with (folder / 'details.csv').open('w', encoding='utf-8-sig', newline='') as target:
        writer = csv.DictWriter(target, fieldnames=list(rows[0]))
        writer.writeheader()
        for row in rows:
            # Protect spreadsheet formula execution in user-controlled file names.
            writer.writerow({k: "'" + v if isinstance(v, str) and v[:1] in ('=', '+', '-', '@') else v for k, v in row.items()})
    for filename in ('input', 'source.image', 'decoded.png', 'optimized.png', 'optimized.jpg', 'encoded.webp', 'name.txt'):
        (folder / filename).unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        status = capabilities()
        if sys.argv[1] == '--check':
            emit(status)
        elif not status['ready']:
            raise ValueError('服务器缺少压缩依赖：' + ', '.join(status['missing']))
        elif sys.argv[1] == '--self-test':
            from PIL import Image
            with tempfile.TemporaryDirectory(prefix='image-codec-check-') as directory:
                folder = Path(directory)
                fixture = Image.new('RGBA', (4, 4), (100, 50, 25, 100))
                fixture.putpixel((0, 0), (11, 22, 33, 0))
                with zipfile.ZipFile(folder / 'input', 'w') as archive:
                    for extension, fmt in [('png', 'PNG'), ('jpg', 'JPEG'), ('webp', 'WEBP')]:
                        stream = io.BytesIO()
                        (fixture.convert('RGB') if fmt == 'JPEG' else fixture).save(stream, format=fmt)
                        archive.writestr('self-test.' + extension, stream.getvalue())
                run(directory)
                emit({'selfTest': 'passed'})
        else:
            run(sys.argv[1])
    except Exception as error:
        # No local paths or subprocess stderr in the public error.
        emit({'error': str(error) if isinstance(error, ValueError) else '图片处理失败，文件可能损坏或单张处理超时'})
        sys.exit(1)
