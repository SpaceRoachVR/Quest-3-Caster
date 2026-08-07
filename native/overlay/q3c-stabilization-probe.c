#include <assert.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
# include <windows.h>
# include <psapi.h>
#endif

#include <libavutil/frame.h>
#include <libavutil/imgutils.h>
#include <libavutil/log.h>

#include "q3c/stabilization_filter.h"

#define WIDTH 2064
#define HEIGHT 1160
#define OUTPUT_WIDTH 1920
#define OUTPUT_HEIGHT 1080
#define SMALL_FRAMES 60
#define RESPONSE_FRAMES 30
#define SUSTAINED_RUN_FRAMES 3600
#define BORDER_DEPTHS 32
#define MIRROR_CONTROL_WIDTHS 3

static const unsigned mirror_control_widths[MIRROR_CONTROL_WIDTHS] = {
    4, 14, 32,
};
static const unsigned mirror_control_offsets[MIRROR_CONTROL_WIDTHS] = {
    0, 17, 73,
};

static uint8_t
coordinate_identity(int source_x, int source_y, unsigned plane) {
    uint32_t value = (uint32_t) source_x * 0x45d9f3bu
                   ^ (uint32_t) source_y * 0x119de1f3u
                   ^ plane * 0x9e3779b9u;
    value ^= value >> 16;
    value *= 0x7feb352du;
    value ^= value >> 15;
    return 16 + value % 220;
}

static bool
allocate_sized_frame(AVFrame **frame, int width, int height) {
    *frame = av_frame_alloc();
    if (!*frame) {
        return false;
    }
    (*frame)->format = AV_PIX_FMT_YUV420P;
    (*frame)->width = width;
    (*frame)->height = height;
    return av_frame_get_buffer(*frame, 32) >= 0;
}

static bool
allocate_frame(AVFrame **frame) {
    return allocate_sized_frame(frame, WIDTH, HEIGHT);
}

static void
render_fixture(AVFrame *frame, double translation_x, double translation_y,
               double angle, int64_t pts) {
    av_frame_make_writable(frame);
    double cosine = cos(angle);
    double sine = sin(angle);
    double cx = WIDTH / 2.0;
    double cy = HEIGHT / 2.0;
    for (int y = 0; y < HEIGHT; ++y) {
        uint8_t *row = frame->data[0] + y * frame->linesize[0];
        for (int x = 0; x < WIDTH; ++x) {
            double dx = x - cx - translation_x;
            double dy = y - cy - translation_y;
            int world_x = (int) llround(cosine * dx + sine * dy + cx);
            int world_y = (int) llround(-sine * dx + cosine * dy + cy);
            uint8_t value = coordinate_identity(world_x, world_y, 0);
            if (abs(world_x - WIDTH / 2) < 18
                    && abs(world_y - HEIGHT / 2) < 18) {
                value = 252;
            }
            row[x] = value;
        }
    }
    for (unsigned plane = 1; plane <= 2; ++plane) {
        for (int y = 0; y < HEIGHT / 2; ++y) {
            uint8_t *row = frame->data[plane] + y * frame->linesize[plane];
            for (int x = 0; x < WIDTH / 2; ++x) {
                row[x] = coordinate_identity(x * 2, y * 2, plane);
            }
        }
    }
    frame->pts = pts;
}

static bool
pixel_identity_equal(const AVFrame *frame, int ax, int ay, int bx, int by) {
    if (frame->data[0][ay * frame->linesize[0] + ax]
            != frame->data[0][by * frame->linesize[0] + bx]) {
        return false;
    }
    for (unsigned plane = 1; plane <= 2; ++plane) {
        int a_index = (ay / 2) * frame->linesize[plane] + ax / 2;
        int b_index = (by / 2) * frame->linesize[plane] + bx / 2;
        if (frame->data[plane][a_index] != frame->data[plane][b_index]) {
            return false;
        }
    }
    return true;
}

enum mirror_edge {
    EDGE_LEFT,
    EDGE_RIGHT,
    EDGE_TOP,
    EDGE_BOTTOM,
};

static bool
mirror_line_matches(const AVFrame *frame, enum mirror_edge edge,
                    int line, int width) {
    unsigned matches = 0;
    for (int depth = 0; depth < width; ++depth) {
        int ax;
        int ay;
        int bx;
        int by;
        switch (edge) {
            case EDGE_LEFT:
                ax = depth;
                ay = line;
                bx = 2 * width - 1 - depth;
                by = line;
                break;
            case EDGE_RIGHT:
                ax = frame->width - 1 - depth;
                ay = line;
                bx = frame->width - 2 * width + depth;
                by = line;
                break;
            case EDGE_TOP:
                ax = line;
                ay = depth;
                bx = line;
                by = 2 * width - 1 - depth;
                break;
            case EDGE_BOTTOM:
                ax = line;
                ay = frame->height - 1 - depth;
                bx = line;
                by = frame->height - 2 * width + depth;
                break;
            default:
                return false;
        }
        matches += pixel_identity_equal(frame, ax, ay, bx, by);
    }
    return matches >= (unsigned) (width * 95 + 99) / 100;
}

static uint64_t
detect_mirrored_borders(const AVFrame *frame) {
    uint64_t mirrored = 0;
    const enum mirror_edge edges[] = {
        EDGE_LEFT, EDGE_RIGHT, EDGE_TOP, EDGE_BOTTOM,
    };
    for (unsigned e = 0; e < sizeof(edges) / sizeof(edges[0]); ++e) {
        bool vertical = edges[e] == EDGE_LEFT || edges[e] == EDGE_RIGHT;
        int lines = vertical ? frame->height : frame->width;
        for (int line = 0; line < lines; line += 2) {
            for (int width = 4; width <= BORDER_DEPTHS; width += 2) {
                if (mirror_line_matches(frame, edges[e], line, width)) {
                    mirrored += width;
                    break;
                }
            }
        }
    }
    return mirrored;
}

static void
render_coordinate_control(AVFrame *frame, unsigned coordinate_offset) {
    av_frame_make_writable(frame);
    for (int y = 0; y < frame->height; ++y) {
        uint8_t *row = frame->data[0] + y * frame->linesize[0];
        for (int x = 0; x < frame->width; ++x) {
            row[x] = coordinate_identity(x + coordinate_offset,
                                         y + coordinate_offset, 0);
        }
    }
    for (unsigned plane = 1; plane <= 2; ++plane) {
        for (int y = 0; y < frame->height / 2; ++y) {
            uint8_t *row = frame->data[plane]
                         + y * frame->linesize[plane];
            for (int x = 0; x < frame->width / 2; ++x) {
                row[x] = coordinate_identity(
                    x * 2 + coordinate_offset, y * 2 + coordinate_offset,
                    plane);
            }
        }
    }
}

static void
inject_mirrored_border(AVFrame *frame, unsigned width,
                       enum mirror_edge edge) {
    for (unsigned plane = 0; plane <= 2; ++plane) {
        int scale = plane ? 2 : 1;
        int plane_width = frame->width / scale;
        int plane_height = frame->height / scale;
        int border_width = (int) width / scale;
        bool vertical = edge == EDGE_LEFT || edge == EDGE_RIGHT;
        int lines = vertical ? plane_height : plane_width;
        for (int line = 0; line < lines; ++line) {
            for (int depth = 0; depth < border_width; ++depth) {
                int destination_x = line;
                int destination_y = depth;
                int source_x = line;
                int source_y = 2 * border_width - 1 - depth;
                if (edge == EDGE_BOTTOM) {
                    destination_y = plane_height - 1 - depth;
                    source_y = plane_height - 2 * border_width + depth;
                } else if (edge == EDGE_LEFT) {
                    destination_x = depth;
                    destination_y = line;
                    source_x = 2 * border_width - 1 - depth;
                    source_y = line;
                } else if (edge == EDGE_RIGHT) {
                    destination_x = plane_width - 1 - depth;
                    destination_y = line;
                    source_x = plane_width - 2 * border_width + depth;
                    source_y = line;
                }
                frame->data[plane][
                    destination_y * frame->linesize[plane] + destination_x]
                    = frame->data[plane][
                        source_y * frame->linesize[plane] + source_x];
            }
        }
    }
}

static unsigned
variable_wedge_width(unsigned line, unsigned extent) {
    unsigned paired_line = line / 2 * 2;
    unsigned steps = (BORDER_DEPTHS - 4) / 2;
    unsigned remaining = extent > paired_line ? extent - paired_line : 0;
    unsigned step = extent ? remaining * steps / extent : 0;
    return 4 + 2 * step;
}

static void
inject_variable_width_wedge(AVFrame *frame, enum mirror_edge edge) {
    bool row_varying_wedge = edge == EDGE_LEFT || edge == EDGE_RIGHT;
    bool column_varying_wedge = !row_varying_wedge;
    (void) column_varying_wedge;
    for (unsigned plane = 0; plane <= 2; ++plane) {
        int scale = plane ? 2 : 1;
        int plane_width = frame->width / scale;
        int plane_height = frame->height / scale;
        int lines = row_varying_wedge ? plane_height : plane_width;
        unsigned full_extent = row_varying_wedge
                             ? frame->height : frame->width;
        for (int line = 0; line < lines; ++line) {
            unsigned full_line = (unsigned) line * scale;
            int border_width =
                (int) variable_wedge_width(full_line, full_extent) / scale;
            for (int depth = 0; depth < border_width; ++depth) {
                int destination_x = line;
                int destination_y = depth;
                int source_x = line;
                int source_y = 2 * border_width - 1 - depth;
                if (edge == EDGE_BOTTOM) {
                    destination_y = plane_height - 1 - depth;
                    source_y = plane_height - 2 * border_width + depth;
                } else if (edge == EDGE_LEFT) {
                    destination_x = depth;
                    destination_y = line;
                    source_x = 2 * border_width - 1 - depth;
                    source_y = line;
                } else if (edge == EDGE_RIGHT) {
                    destination_x = plane_width - 1 - depth;
                    destination_y = line;
                    source_x = plane_width - 2 * border_width + depth;
                    source_y = line;
                }
                frame->data[plane][
                    destination_y * frame->linesize[plane] + destination_x]
                    = frame->data[plane][
                        source_y * frame->linesize[plane] + source_x];
            }
        }
    }
}

static bool
validate_mirror_controls(unsigned *positive_controls,
                         bool *negative_control) {
    AVFrame *control = NULL;
    if (!allocate_sized_frame(&control, OUTPUT_WIDTH, OUTPUT_HEIGHT)) {
        av_frame_free(&control);
        return false;
    }
    *positive_controls = 0;
    render_coordinate_control(control, 41);
    *negative_control = detect_mirrored_borders(control) == 0;
    const enum mirror_edge edges[] = {
        EDGE_LEFT, EDGE_RIGHT, EDGE_TOP, EDGE_BOTTOM,
    };
    for (unsigned i = 0; i < MIRROR_CONTROL_WIDTHS; ++i) {
        for (unsigned edge = 0; edge < sizeof(edges) / sizeof(edges[0]);
                ++edge) {
            render_coordinate_control(control, mirror_control_offsets[i]);
            inject_mirrored_border(control, mirror_control_widths[i],
                                   edges[edge]);
            if (detect_mirrored_borders(control) == 0) {
                av_frame_free(&control);
                return false;
            }
            ++*positive_controls;
        }
    }
    for (unsigned edge = 0; edge < sizeof(edges) / sizeof(edges[0]); ++edge) {
        render_coordinate_control(control, 101 + edge * 13);
        inject_variable_width_wedge(control, edges[edge]);
        if (detect_mirrored_borders(control) == 0) {
            av_frame_free(&control);
            return false;
        }
        ++*positive_controls;
    }
    av_frame_free(&control);
    return *negative_control
        && *positive_controls == MIRROR_CONTROL_WIDTHS * 4 + 4;
}

static bool
marker_centroid(const AVFrame *frame, double *x_out, double *y_out,
                uint64_t *border_pixels, uint64_t *mirrored_border_pixels) {
    uint64_t x_sum = 0;
    uint64_t y_sum = 0;
    uint64_t count = 0;
    uint64_t borders = 0;
    for (int y = 0; y < frame->height; ++y) {
        const uint8_t *row = frame->data[0] + y * frame->linesize[0];
        for (int x = 0; x < frame->width; ++x) {
            if (row[x] == 0) {
                ++borders;
            }
            if (row[x] >= 248) {
                x_sum += x;
                y_sum += y;
                ++count;
            }
        }
    }
    if (!count) {
        return false;
    }
    *x_out = (double) x_sum / count;
    *y_out = (double) y_sum / count;
    *border_pixels += borders;
    *mirrored_border_pixels += detect_mirrored_borders(frame);
    return true;
}

#ifdef _WIN32
static size_t
working_set_bytes(void) {
    PROCESS_MEMORY_COUNTERS_EX counters;
    memset(&counters, 0, sizeof(counters));
    counters.cb = sizeof(counters);
    if (!GetProcessMemoryInfo(GetCurrentProcess(),
                              (PROCESS_MEMORY_COUNTERS *) &counters,
                              sizeof(counters))) {
        return SIZE_MAX;
    }
    return counters.WorkingSetSize;
}
#endif

static double
rms_about_mean(const double *values, unsigned count) {
    double mean = 0;
    for (unsigned i = 0; i < count; ++i) {
        mean += values[i];
    }
    mean /= count;
    double squared = 0;
    for (unsigned i = 0; i < count; ++i) {
        double delta = values[i] - mean;
        squared += delta * delta;
    }
    return sqrt(squared / count);
}

static int
forced_failure_probe(void) {
    struct q3c_stabilization_filter filter;
    char error[256];
    bool opened = q3c_stabilization_filter_open(
        &filter, WIDTH, HEIGHT, AV_PIX_FMT_YUV420P, (AVRational) {1, 60},
        true, error, sizeof(error));
    if (opened || !strstr(error, "forced")) {
        return 1;
    }
    printf("{\"schemaVersion\":1,\"forcedFailure\":true,"
           "\"cleanup\":\"passed\",\"code\":\"stabilization_unavailable\"}\n");
    return 0;
}

static int
synthetic_probe(void) {
    av_log_set_level(AV_LOG_WARNING);
    unsigned mirror_positive_controls = 0;
    bool mirror_negative_control = false;
    if (!validate_mirror_controls(&mirror_positive_controls,
                                  &mirror_negative_control)) {
        fprintf(stderr, "mirror detector controls failed\n");
        return 1;
    }
    struct q3c_stabilization_filter filter;
    char error[512];
    if (!q3c_stabilization_filter_open(
            &filter, WIDTH, HEIGHT, AV_PIX_FMT_YUV420P,
            (AVRational) {1, 60}, false, error, sizeof(error))) {
        fprintf(stderr, "filter initialization failed: %s\n", error);
        return 1;
    }
    AVFrame *input = NULL;
    if (!allocate_frame(&input)) {
        q3c_stabilization_filter_close(&filter);
        return 1;
    }

    double baseline_x[SMALL_FRAMES];
    double output_x[SMALL_FRAMES];
    unsigned output_count = 0;
    uint64_t border_pixels = 0;
    uint64_t mirrored_border_pixels = 0;
    unsigned border_samples = 0;
#ifdef _WIN32
    size_t initial_working_set = working_set_bytes();
    size_t peak_working_set = initial_working_set;
#else
    size_t initial_working_set = 0;
    size_t peak_working_set = 0;
#endif
    static const int jitter[] = {-6, 4, -3, 6, -5, 2, -1, 5};
    int64_t pts = 0;
    unsigned return_availability_frame = 0;
    bool have_previous_sustained_centroid = false;
    double previous_sustained_x = 0;
    unsigned previous_sustained_frame = 0;
    unsigned measurement_frames = SMALL_FRAMES + RESPONSE_FRAMES;
    for (unsigned i = 0; i < measurement_frames; ++i) {
        double tx;
        double ty;
        double angle;
        if (i < SMALL_FRAMES) {
            tx = jitter[i % 8];
            ty = jitter[(i + 3) % 8] * 0.6;
            angle = jitter[(i + 5) % 8] * 0.00045;
            baseline_x[i] = tx;
        } else {
            tx = (i - SMALL_FRAMES + 1) * 4.0;
            ty = (i - SMALL_FRAMES + 1) * 1.5;
            angle = (i - SMALL_FRAMES + 1) * 0.0008;
        }
        render_fixture(input, tx, ty, angle, pts++);
        AVFrame *output = NULL;
        bool has_output = false;
        if (!q3c_stabilization_filter_push(&filter, input, &output,
                                           &has_output, error,
                                           sizeof(error))) {
            fprintf(stderr, "frame processing failed: %s\n", error);
            av_frame_free(&input);
            q3c_stabilization_filter_close(&filter);
            return 1;
        }
        if (!has_output) {
            continue;
        }
        if (output->width != OUTPUT_WIDTH || output->height != OUTPUT_HEIGHT) {
            return 1;
        }
        double cx;
        double cy;
        if (!marker_centroid(output, &cx, &cy, &border_pixels,
                             &mirrored_border_pixels)) {
            return 1;
        }
        ++border_samples;
#ifdef _WIN32
        size_t current_working_set = working_set_bytes();
        if (current_working_set == SIZE_MAX) {
            return 1;
        }
        if (current_working_set > peak_working_set) {
            peak_working_set = current_working_set;
        }
#endif
        unsigned output_frame = (unsigned) output->pts;
        if (output_frame < SMALL_FRAMES && output_count < SMALL_FRAMES) {
            output_x[output_count++] = cx;
        } else if (output_frame >= SMALL_FRAMES) {
            if (!return_availability_frame
                    && have_previous_sustained_centroid
                    && output_frame == previous_sustained_frame + 1
                    && cx - previous_sustained_x >= 4.0 * 0.8) {
                return_availability_frame = i - SMALL_FRAMES + 1;
            }
            previous_sustained_x = cx;
            previous_sustained_frame = output_frame;
            have_previous_sustained_centroid = true;
        }
    }

    size_t midpoint_working_set = 0;
    size_t final_working_set = 0;
    render_fixture(input, 0, 0, 0, pts++);
    for (unsigned i = 0; i < SUSTAINED_RUN_FRAMES; ++i) {
        input->pts = pts++;
        AVFrame *output = NULL;
        bool has_output = false;
        if (!q3c_stabilization_filter_push(&filter, input, &output,
                                           &has_output, error,
                                           sizeof(error))) {
            fprintf(stderr, "sustained frame processing failed: %s\n", error);
            av_frame_free(&input);
            q3c_stabilization_filter_close(&filter);
            return 1;
        }
#ifdef _WIN32
        size_t current_working_set = working_set_bytes();
        if (current_working_set == SIZE_MAX) {
            return 1;
        }
        if (current_working_set > peak_working_set) {
            peak_working_set = current_working_set;
        }
        if (i == SUSTAINED_RUN_FRAMES / 2) {
            midpoint_working_set = current_working_set;
        }
        if (i + 1 == SUSTAINED_RUN_FRAMES) {
            final_working_set = current_working_set;
        }
#endif
        if (has_output && i % 60 == 0) {
            double cx;
            double cy;
            if (!marker_centroid(output, &cx, &cy, &border_pixels,
                                 &mirrored_border_pixels)) {
                return 1;
            }
            ++border_samples;
        }
    }

    if (output_count < SMALL_FRAMES / 2) {
        fprintf(stderr, "insufficient stabilized output frames: %u\n",
                output_count);
        av_frame_free(&input);
        q3c_stabilization_filter_close(&filter);
        return 1;
    }
    double input_rms = rms_about_mean(baseline_x, SMALL_FRAMES);
    double output_rms = rms_about_mean(output_x, output_count);
    double reduction = 100.0 * (1.0 - output_rms / input_rms);
    unsigned return_ms = return_availability_frame
                       ? return_availability_frame * 1000 / 60 : 10000;
    unsigned submission_to_output_ms =
        filter.last_submission_to_output_ms;
    unsigned peak_depth = filter.peak_queue_depth;
    bool cleanup_before_close = filter.graph && filter.device;
    const char *gpu = filter.gpu_name;
    char gpu_copy[256];
    snprintf(gpu_copy, sizeof(gpu_copy), "%s", gpu);
    av_frame_free(&input);
    q3c_stabilization_filter_close(&filter);
    bool cleanup = cleanup_before_close && !filter.graph && !filter.device
                && !filter.output && filter.queued_frames == 0;
    size_t working_set_growth = peak_working_set >= initial_working_set
                              ? peak_working_set - initial_working_set
                              : 0;
    bool bounded_memory = peak_working_set < 512u * 1024u * 1024u
                       && working_set_growth < 256u * 1024u * 1024u;
    int64_t memory_slope = final_working_set >= midpoint_working_set
                         ? (int64_t) ((final_working_set
                                      - midpoint_working_set)
                                     / (SUSTAINED_RUN_FRAMES / 2))
                         : 0;
    size_t second_half_growth = final_working_set >= midpoint_working_set
                              ? final_working_set - midpoint_working_set : 0;
    bounded_memory &= second_half_growth < 32u * 1024u * 1024u;

    printf("{\"schemaVersion\":1,\"gpu\":\"%s\","
           "\"smallMotionInputRms\":%.4f,\"smallMotionOutputRms\":%.4f,"
           "\"smallMotionReductionPercent\":%.2f,"
           "\"sustainedMotionReturnMs\":%u,"
           "\"submissionToOutputMs\":%u,\"outputWidth\":1920,"
           "\"outputHeight\":1080,\"borderPixels\":%u,"
           "\"mirroredBorderPixels\":%u,\"borderDepthsChecked\":%u,"
           "\"borderSamples\":%u,\"mirrorPositiveControls\":%u,"
           "\"mirrorNegativeControl\":%s,\"sustainedRunFrames\":%u,"
           "\"peakQueueDepth\":%u,"
           "\"peakWorkingSetBytes\":%zu,\"workingSetGrowthBytes\":%zu,"
           "\"memorySlopeBytesPerFrame\":%lld,"
           "\"secondHalfWorkingSetGrowthBytes\":%zu,"
           "\"boundedMemory\":%s,\"cleanup\":%s}\n",
           gpu_copy, input_rms, output_rms, reduction, return_ms,
           submission_to_output_ms, (unsigned) border_pixels,
           (unsigned) mirrored_border_pixels, BORDER_DEPTHS, border_samples,
           mirror_positive_controls,
           mirror_negative_control ? "true" : "false",
           SUSTAINED_RUN_FRAMES, peak_depth,
           peak_working_set, working_set_growth,
           (long long) memory_slope,
           second_half_growth,
           bounded_memory ? "true" : "false",
           cleanup ? "true" : "false");

    return reduction >= 30.0 && return_ms <= 150
        && submission_to_output_ms == 100 && border_pixels == 0
        && mirrored_border_pixels == 0 && peak_depth <= 12
        && border_samples >= 60 && mirror_positive_controls == 16
        && mirror_negative_control && bounded_memory && cleanup ? 0 : 1;
}

int
main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "Usage: %s --synthetic|--forced-failure\n", argv[0]);
        return 2;
    }
    if (!strcmp(argv[1], "--synthetic")) {
        return synthetic_probe();
    }
    if (!strcmp(argv[1], "--forced-failure")) {
        return forced_failure_probe();
    }
    return 2;
}
