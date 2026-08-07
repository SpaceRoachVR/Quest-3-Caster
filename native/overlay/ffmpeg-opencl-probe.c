#include <stdio.h>

#include <libavfilter/avfilter.h>
#include <libavutil/avutil.h>

int
main(void) {
    const char *ffmpeg_version = av_version_info();
    const char *required_filter = "deshake_opencl";
    const AVFilter *filter = avfilter_get_by_name(required_filter);
    if (!filter) {
        fprintf(stderr, "%s is unavailable\n", required_filter);
        return 1;
    }

    unsigned version = avfilter_version();
    printf("ffmpeg_version=%s\n", ffmpeg_version);
    printf("%s available via libavfilter %u.%u.%u\n",
           required_filter,
           AV_VERSION_MAJOR(version),
           AV_VERSION_MINOR(version),
           AV_VERSION_MICRO(version));
    return 0;
}
