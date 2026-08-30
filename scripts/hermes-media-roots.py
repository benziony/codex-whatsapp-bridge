#!/usr/bin/env python3
import json

from gateway.platforms.base import (
    get_audio_cache_dir,
    get_document_cache_dir,
    get_image_cache_dir,
    get_video_cache_dir,
)

print(
    json.dumps(
        [
            str(get_image_cache_dir()),
            str(get_audio_cache_dir()),
            str(get_video_cache_dir()),
            str(get_document_cache_dir()),
        ]
    )
)

