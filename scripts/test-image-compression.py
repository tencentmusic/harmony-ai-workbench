import importlib.util
import io
import os
import json
from pathlib import Path
import sys
sys.dont_write_bytecode = True
import tempfile
import zipfile
from PIL import Image

worker = Path(__file__).resolve().parents[1] / 'server/image-compression/worker.py'
spec = importlib.util.spec_from_file_location('compression', worker)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def encode(image):
    stream = io.BytesIO()
    image.save(stream, format='PNG', compress_level=0)
    return stream.getvalue()


with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    image = Image.new('RGBA', (64, 48), (14, 32, 96, 255))
    image.putpixel((0, 0), (81, 72, 63, 0))  # Invisible RGB must survive too.
    image.putpixel((1, 0), (99, 100, 101, 42))
    original = encode(image)
    animation = io.BytesIO()
    image.save(animation, format='PNG', save_all=True, append_images=[Image.new('RGBA', image.size, 'red')], duration=80, loop=0)
    with zipfile.ZipFile(root / 'input', 'w') as archive:
        archive.writestr('资源/first.png', original)
        archive.writestr('资源/repeat.png', original)
        archive.writestr('animation.png', animation.getvalue())
    module.run(root)
    report = json.loads((root / 'report.json').read_text())
    assert report['count'] == 3 and report['verifiedCount'] == 2
    assert report['duplicates'] == [['资源/first.png', '资源/repeat.png']]
    for key in ('png', 'webp', 'smallest'):
        with zipfile.ZipFile(root / (key + '.zip')) as archive:
            assert archive.testzip() is None
            assert len(archive.namelist()) == 3
            assert archive.read('animation.png') == animation.getvalue()
            for name in archive.namelist():
                if name != 'animation.png':
                    assert module.rgba(archive.read(name)) == module.rgba(original)
        assert report['variants'][key]['bytes'] <= report['originalBytes']
    assert not (root / 'input').exists()
    for filename in ('../escape.png', '/absolute.png', 'a\\b.png', 'same.png'):
        with zipfile.ZipFile(root / 'input', 'w') as archive:
            archive.writestr(filename, original)
            if filename == 'same.png':
                archive.writestr('SAME.PNG', original)
        try:
            list(module.inputs(root / 'input'))
            raise AssertionError('unsafe archive accepted')
        except ValueError:
            pass
    with zipfile.ZipFile(root / 'input', 'w') as archive:
        archive.writestr('not-image.txt', 'hello')
    try:
        list(module.inputs(root / 'input'))
        raise AssertionError('unexpected file accepted')
    except ValueError:
        pass
print('image-compression: exact RGBA (including hidden RGB), animation preservation, duplicates, ZIP integrity and unsafe archive checks passed')

# A codec may exist on PATH while its dynamic libraries are missing.
with tempfile.TemporaryDirectory() as temp:
    broken = Path(temp) / 'cwebp'
    broken.write_text('#!/bin/sh\nexit 1\n')
    broken.chmod(0o755)
    previous = os.environ.get('IMAGE_CWEBP')
    try:
        os.environ['IMAGE_CWEBP'] = str(broken)
        assert not module.capabilities()['ready'], 'broken codec must not report ready'
    finally:
        if previous is None:
            os.environ.pop('IMAGE_CWEBP', None)
        else:
            os.environ['IMAGE_CWEBP'] = previous
print('image-compression: broken codec readiness check passed')

# Mixed formats, case-insensitive extensions and conversion name collisions.
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    fixtures = {'资源/icon.png': original}
    for name, fmt in [('资源/icon.JPG', 'JPEG'), ('资源/icon.JPEG', 'JPEG'), ('资源/icon.webp', 'WEBP')]:
        stream = io.BytesIO()
        image.convert('RGB').save(stream, format=fmt, quality=95)
        fixtures[name] = stream.getvalue()
    fixtures['资源/icon.png.webp'] = fixtures['资源/icon.webp']
    stream = io.BytesIO()
    image.save(stream, format='WEBP', save_all=True, append_images=[Image.new('RGBA', image.size, 'red')], duration=80, loop=0)
    fixtures['animation.webp'] = stream.getvalue()
    stream = io.BytesIO()
    exif = Image.Exif()
    exif[274] = 6
    image.convert('RGB').save(stream, format='JPEG', exif=exif)
    fixtures['oriented.jpg'] = stream.getvalue()
    with zipfile.ZipFile(root / 'input', 'w') as archive:
        for name, data in fixtures.items():
            archive.writestr(name, data)
    module.run(root)
    report = json.loads((root / 'report.json').read_text())
    assert report['count'] == len(fixtures)
    assert any(row['webpName'].endswith('.2.webp') for row in report['rows'])
    for key in ('png', 'webp', 'smallest'):
        with zipfile.ZipFile(root / (key + '.zip')) as archive:
            names = archive.namelist()
            assert len(names) == len(fixtures) == len(set(n.casefold() for n in names))
            for row in report['rows']:
                output = row['name'] if key == 'png' else row['webpName'] if key == 'webp' else row['outputName']
                data = archive.read(output)
                assert len(data) <= len(fixtures[row['name']])
                assert module.rgba(data) == module.rgba(fixtures[row['name']])
                if row['name'] == 'animation.webp':
                    assert data == fixtures[row['name']]
                if row['name'] == 'oriented.jpg':
                    assert Image.open(io.BytesIO(data)).getexif()[274] == 6
    # Standalone uploads follow the same content checks and encoding path.
    for name in ('资源/icon.JPG', '资源/icon.JPEG', '资源/icon.webp'):
        (root / 'input').write_bytes(fixtures[name])
        (root / 'name.txt').write_text(name.split('/')[-1])
        module.run(root)
        assert json.loads((root / 'report.json').read_text())['count'] == 1
print('image-compression: mixed PNG/JPEG/WebP, collisions, metadata, animations and standalone files passed')

# Allowed extensions cannot disguise unsupported or corrupt image contents.
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    (root / 'input').write_bytes(original)
    (root / 'name.txt').write_text('disguised.jpg')
    try:
        module.run(root)
        raise AssertionError('mismatched content accepted')
    except ValueError as error:
        assert '扩展名' in str(error)
