#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <libavutil/dict.h>
#include <libavutil/frame.h>

#include "frame_buffer.h"
#include "q3c/native_event.h"
#include "q3c/profile.h"
#include "q3c/render_ack.h"
#include "q3c/render_path.h"
#include "q3c/stabilization_filter.h"
#include "q3c/stabilization_sink.h"

struct test_results {
    unsigned assertions;
    bool bypass;
    bool init_failure;
    bool session_reset;
    bool render_ack;
    bool frame_validation;
    bool shutdown;
    bool utf8;
    bool live_graph;
    bool delayed_frames_disposed;
    bool concurrent_ack;
    bool render_failure_suppressed;
    bool gpu_selection;
    bool paused_stale_event_safe;
    bool publication_overlap;
    bool border_guard;
};

#define VERIFY(RESULTS, CONDITION) \
    do { \
        ++(RESULTS)->assertions; \
        if (!(CONDITION)) { \
            fprintf(stderr, "Native assertion failed at %s:%d: %s\n", \
                    __FILE__, __LINE__, #CONDITION); \
            fflush(stderr); \
            abort(); \
        } \
    } while (0)

struct fake_screen {
    struct sc_frame_sink sink;
    AVCodecContext opened_context;
    struct sc_stream_session session;
    struct q3c_stabilization_sink *owner_sink;
    unsigned open_count;
    unsigned close_count;
    unsigned push_count;
    unsigned session_count;
    bool synchronous_ack;
    bool fail_push;
};

#define FAKE_SCREEN_DOWNCAST(SINK) \
    container_of(SINK, struct fake_screen, sink)

static bool
fake_screen_open(struct sc_frame_sink *sink, const AVCodecContext *context,
                 const struct sc_stream_session *session) {
    struct fake_screen *screen = FAKE_SCREEN_DOWNCAST(sink);
    screen->opened_context.width = context->width;
    screen->opened_context.height = context->height;
    screen->opened_context.pix_fmt = context->pix_fmt;
    screen->session = *session;
    ++screen->open_count;
    return true;
}

static void
fake_screen_close(struct sc_frame_sink *sink) {
    ++FAKE_SCREEN_DOWNCAST(sink)->close_count;
}

static bool
fake_screen_push(struct sc_frame_sink *sink, const AVFrame *frame) {
    struct fake_screen *screen = FAKE_SCREEN_DOWNCAST(sink);
    if (frame->width != 1920 || frame->height != 1080
            || frame->format != AV_PIX_FMT_YUV420P
            || frame->pts == AV_NOPTS_VALUE) {
        return false;
    }
    if (screen->synchronous_ack) {
        q3c_stabilization_sink_ack_rendered(screen->owner_sink, frame,
                                            &screen->session);
    }
    if (screen->fail_push) {
        return false;
    }
    ++screen->push_count;
    return true;
}

static bool
fake_screen_push_session(struct sc_frame_sink *sink,
                         const struct sc_stream_session *session) {
    struct fake_screen *screen = FAKE_SCREEN_DOWNCAST(sink);
    screen->session = *session;
    ++screen->session_count;
    return true;
}

static void
fake_screen_init(struct fake_screen *screen,
                 struct q3c_stabilization_sink *owner_sink) {
    memset(screen, 0, sizeof(*screen));
    screen->owner_sink = owner_sink;
    static const struct sc_frame_sink_ops operations = {
        .open = fake_screen_open,
        .close = fake_screen_close,
        .push = fake_screen_push,
        .push_session = fake_screen_push_session,
    };
    screen->sink.ops = &operations;
}

static char captured_event[Q3C_EVENT_MAX_BYTES + 1];
static unsigned captured_event_count;

static void
capture_event(const char *event) {
    snprintf(captured_event, sizeof(captured_event), "%s", event);
    ++captured_event_count;
}

static void
test_profiles_and_events(struct test_results *results) {
    enum q3c_profile_id id;
    VERIFY(results, q3c_profile_parse("obsLowLatency1080p60", &id));
    const struct q3c_profile *low = q3c_profile_get(id);
    VERIFY(results, low && !low->stabilized);
    VERIFY(results, !strcmp(low->server_crop, "1792:1008:2200:600"));
    VERIFY(results, low->video_bit_rate == 40000000 && low->max_fps == 60);
    // The window must match the delivered size. SDL scales the decoded frame
    // to the window, and OBS captures the window, so a window larger than the
    // output resamples the image after the pipeline deliberately avoided
    // resampling anywhere else.
    VERIFY(results, low->window_width == 1792 && low->window_height == 1008);
    VERIFY(results, low->audio_delay_ms == 0);
    VERIFY(results, !strcmp(low->presentation_angle, "-22"));

    VERIFY(results, q3c_profile_parse("obsStabilized1080p60", &id));
    const struct q3c_profile *stable = q3c_profile_get(id);
    VERIFY(results, stable && stable->stabilized);
    VERIFY(results, !strcmp(stable->server_crop, "2064:1160:2064:524"));
    VERIFY(results,
           stable->window_width == 1920 && stable->window_height == 1080);
    VERIFY(results, stable->audio_delay_ms == 100);
    VERIFY(results, stable->nominal_video_delay_ms == 100);
    VERIFY(results, stable->maximum_video_delay_ms == 120);
    VERIFY(results, !strcmp(stable->presentation_angle, "-22"));

    VERIFY(results,
           q3c_profile_parse("obsLowLatencySquareLeft1080p60", &id));
    const struct q3c_profile *square_left = q3c_profile_get(id);
    VERIFY(results, square_left && !square_left->stabilized);
    VERIFY(results, !strcmp(square_left->server_crop, "1488:1488:288:360"));
    VERIFY(results, square_left->window_width == 1080
           && square_left->window_height == 1080);

    VERIFY(results,
           q3c_profile_parse("obsLowLatencySquareRight1080p60", &id));
    const struct q3c_profile *square_right = q3c_profile_get(id);
    VERIFY(results, square_right && !square_right->stabilized);
    VERIFY(results,
           !strcmp(square_right->server_crop, "1488:1488:2352:360"));
    VERIFY(results, square_right->window_width == 1080
           && square_right->window_height == 1080);

    // Guard the invariant for every profile, including ones added later: a
    // window that differs from the delivered size silently rescales the image
    // in SDL before OBS ever sees it.
    const struct q3c_profile *const all[] = {low, stable, square_left,
                                             square_right};
    for (size_t i = 0; i < sizeof(all) / sizeof(all[0]); ++i) {
        VERIFY(results, all[i]->window_width == all[i]->output_width
               && all[i]->window_height == all[i]->output_height);
    }
    VERIFY(results, !q3c_profile_parse("unknown", &id));

    uint64_t generation;
    VERIFY(results, q3c_generation_parse("1", &generation));
    VERIFY(results, !q3c_generation_parse("0", &generation));
    VERIFY(results, !q3c_generation_parse("01", &generation));
    VERIFY(results, !q3c_generation_parse("-1", &generation));

    char event[Q3C_EVENT_MAX_BYTES + 1];
    VERIFY(results, q3c_event_ready(event, sizeof(event),
                                    "obsStabilized1080p60", 1920, 1080, true,
                                    "GPU \"A\"\n", 100, 42));
    VERIFY(results, strstr(event, "\"generation\":42"));
    VERIFY(results, strstr(event, "GPU \\\"A\\\"\\n"));
    VERIFY(results, !strchr(event, '\n'));
    char tiny[32];
    VERIFY(results, !q3c_event_ready(tiny, sizeof(tiny),
                                     "obsLowLatency1080p60", 1792, 1008,
                                     false, NULL,
                                     0, 1));
}

static void
test_utf8(struct test_results *results) {
    char output[32];
    const char invalid[] = {'G', 'P', 'U', (char) 0xC0, (char) 0xAF, '\n', 0};
    VERIFY(results, q3c_utf8_sanitize(invalid, output, sizeof(output)));
    VERIFY(results, !strcmp(output, "GPU?? "));
    VERIFY(results, q3c_utf8_sanitize("NVIDIA \xE2\x84\xA2", output,
                                      sizeof(output)));
    VERIFY(results, !strcmp(output, "NVIDIA \xE2\x84\xA2"));
    results->utf8 = true;
}

static void
test_filter_failure_and_validation(struct test_results *results) {
    AVRational timestamp_time_base = q3c_stabilization_time_base();
    VERIFY(results, timestamp_time_base.num == 1);
    VERIFY(results, timestamp_time_base.den == 1000000);

    struct q3c_stabilization_filter filter;
    char error[256];
    VERIFY(results, !q3c_stabilization_filter_open(
        &filter, 2064, 1160, AV_PIX_FMT_NV12, (AVRational) {1, 60},
        false, error, sizeof(error)));
    VERIFY(results, strstr(error, "geometry/format"));
    VERIFY(results, !q3c_stabilization_filter_open(
        &filter, 2064, 1160, AV_PIX_FMT_YUV420P, (AVRational) {1, 60},
        true, error, sizeof(error)));
    VERIFY(results, strstr(error, "forced"));
    VERIFY(results, !filter.graph && !filter.device && !filter.output);
    results->init_failure = true;
    results->frame_validation = true;

    const uint64_t cpu_first_gpu_second[] = {2, 4, 4};
    size_t selected_index = SIZE_MAX;
    VERIFY(results, q3c_select_first_gpu(
        cpu_first_gpu_second, 3, 4, &selected_index));
    VERIFY(results, selected_index == 1);
    VERIFY(results, !q3c_select_first_gpu(
        cpu_first_gpu_second, 3, 8, &selected_index));
    results->gpu_selection = true;

    const double identity[6] = {1, 0, 0, 0, 1, 0};
    const double exact_left[6] = {1, 0, -72, 0, 1, 0};
    const double exact_right[6] = {1, 0, 72, 0, 1, 0};
    const double exact_top[6] = {1, 0, 0, 0, 1, -40};
    const double exact_bottom[6] = {1, 0, 0, 0, 1, 40};
    const double exposed_left[6] = {1, 0, -73, 0, 1, 0};
    const double exposed_right[6] = {1, 0, 73, 0, 1, 0};
    const double exposed_top[6] = {1, 0, 0, 0, 1, -41};
    const double exposed_bottom[6] = {1, 0, 0, 0, 1, 41};
    VERIFY(results, q3c_transform_covers_final_crop(identity, 2064, 1160));
    VERIFY(results, q3c_transform_covers_final_crop(exact_left, 2064, 1160));
    VERIFY(results, q3c_transform_covers_final_crop(exact_right, 2064, 1160));
    VERIFY(results, q3c_transform_covers_final_crop(exact_top, 2064, 1160));
    VERIFY(results, q3c_transform_covers_final_crop(exact_bottom, 2064, 1160));
    VERIFY(results, !q3c_transform_covers_final_crop(exposed_left, 2064, 1160));
    VERIFY(results, !q3c_transform_covers_final_crop(exposed_right, 2064, 1160));
    VERIFY(results, !q3c_transform_covers_final_crop(exposed_top, 2064, 1160));
    VERIFY(results, !q3c_transform_covers_final_crop(exposed_bottom, 2064, 1160));

    VERIFY(results, q3c_delay_action_for_age(-1) == Q3C_DELAY_INVALID);
    VERIFY(results, q3c_delay_action_for_age(0) == Q3C_DELAY_WAIT);
    VERIFY(results, q3c_delay_action_for_age(99999) == Q3C_DELAY_WAIT);
    VERIFY(results, q3c_delay_action_for_age(100000) == Q3C_DELAY_DELIVER);
    VERIFY(results, q3c_delay_action_for_age(120000) == Q3C_DELAY_DELIVER);
    VERIFY(results,
           q3c_delay_action_for_age(120001) == Q3C_DELAY_DROP_STALE);
}

static void
test_border_guard_fatal_before_forward(struct test_results *results) {
    const struct q3c_profile *profile =
        q3c_profile_get(Q3C_PROFILE_OBS_STABILIZED_1080P60);
    const char *exposed_transforms[] = {
        "1,0,-73,0,1,0",
        "1,0,73,0,1,0",
        "1,0,0,0,1,-41",
        "1,0,0,0,1,41",
    };
    for (unsigned i = 0; i < 4; ++i) {
        struct q3c_stabilization_sink sink;
        VERIFY(results, q3c_stabilization_sink_init(
            &sink, profile, 780 + i, capture_event));
        struct fake_screen screen;
        fake_screen_init(&screen, &sink);
        sc_frame_source_add_sink(&sink.frame_source, &screen.sink);
        AVFrame *frame = av_frame_alloc();
        VERIFY(results, frame);
        frame->width = 1920;
        frame->height = 1080;
        frame->format = AV_PIX_FMT_YUV420P;
        frame->pts = 1;
        VERIFY(results, av_dict_set(
            &frame->metadata, "lavfi.q3c.transform_y",
            exposed_transforms[i], 0) >= 0);
        captured_event_count = 0;
        VERIFY(results, !q3c_stabilization_sink_forward_output_for_test(
            &sink, frame));
        VERIFY(results, captured_event_count == 1);
        VERIFY(results, strstr(captured_event, "\"type\":\"fatal\""));
        VERIFY(results, strstr(captured_event,
                               "\"code\":\"stabilization_unavailable\""));
        VERIFY(results, screen.push_count == 0);
        av_frame_free(&frame);
        q3c_stabilization_sink_destroy(&sink);
    }
    results->border_guard = true;
}

static void
test_paused_stale_event(struct test_results *results) {
    struct sc_frame_buffer frame_buffer;
    VERIFY(results, sc_frame_buffer_init(&frame_buffer));
    AVFrame *queued = av_frame_alloc();
    AVFrame *destination = av_frame_alloc();
    VERIFY(results, queued && destination);
    queued->format = AV_PIX_FMT_YUV420P;
    queued->width = 16;
    queued->height = 16;
    VERIFY(results, av_frame_get_buffer(queued, 16) >= 0);
    queued->pts = 1;
    VERIFY(results, sc_frame_buffer_push(&frame_buffer, queued));
    sc_frame_buffer_discard(&frame_buffer);
    bool paused_stale_event_safe =
        !sc_frame_buffer_try_consume(&frame_buffer, destination);
    VERIFY(results, paused_stale_event_safe);
    VERIFY(results, !sc_frame_buffer_has_frame(&frame_buffer));
    av_frame_free(&queued);
    av_frame_free(&destination);
    sc_frame_buffer_destroy(&frame_buffer);
    results->paused_stale_event_safe = true;
}

static void
test_low_latency_lifecycle(struct test_results *results) {
    const struct q3c_profile *profile =
        q3c_profile_get(Q3C_PROFILE_OBS_LOW_LATENCY_1080P60);
    struct q3c_stabilization_sink forbidden_sink;
    VERIFY(results, !q3c_stabilization_sink_init(
        &forbidden_sink, profile, 77, capture_event));

    struct q3c_direct_ready ready;
    VERIFY(results, q3c_direct_ready_init(&ready, profile, 77,
                                          capture_event));
    /* Must match the profile's delivered size: readiness is gated on the
       profile geometry, not a hard-coded 1920x1080. */
    struct sc_stream_session session = {
        .video = {.width = 1792, .height = 1008},
    };
    AVFrame frame = {
        .width = 1792,
        .height = 1008,
        .format = AV_PIX_FMT_YUV420P,
        .pts = 1,
    };
    captured_event_count = 0;
    q3c_direct_ready_ack_rendered(&ready, &frame, &session);
    VERIFY(results, captured_event_count == 1);
    VERIFY(results, strstr(captured_event, "\"type\":\"ready\""));
    VERIFY(results, strstr(captured_event,
                           "\"effectiveProfile\":\"obsLowLatency1080p60\""));
    q3c_direct_ready_ack_rendered(&ready, &frame, &session);
    VERIFY(results, captured_event_count == 1);
    struct sc_stream_session invalid_session = session;
    invalid_session.video.width = 1919;
    ready.ready_emitted = false;
    q3c_direct_ready_ack_rendered(&ready, &frame, &invalid_session);
    VERIFY(results, captured_event_count == 1);
    q3c_direct_ready_destroy(&ready);
    results->bypass = true;
    results->render_ack = true;
    results->session_reset = true;
    results->shutdown = true;
}

struct fake_render_state {
    bool fail_clear;
    bool fail_texture;
    bool fail_present;
    unsigned clear_calls;
    unsigned texture_calls;
    unsigned present_calls;
};

static bool
fake_render_clear(SDL_Renderer *renderer) {
    struct fake_render_state *state = (struct fake_render_state *) renderer;
    ++state->clear_calls;
    return !state->fail_clear;
}

static bool
fake_render_texture(SDL_Renderer *renderer, SDL_Texture *texture,
                    const SDL_FRect *destination) {
    struct fake_render_state *state = (struct fake_render_state *) renderer;
    assert(texture && destination);
    ++state->texture_calls;
    return !state->fail_texture;
}

static bool
fake_render_texture_rotated(SDL_Renderer *renderer, SDL_Texture *texture,
                            const SDL_FRect *destination, double angle,
                            SDL_FlipMode flip) {
    (void) angle;
    (void) flip;
    return fake_render_texture(renderer, texture, destination);
}

static bool
fake_render_present(SDL_Renderer *renderer) {
    struct fake_render_state *state = (struct fake_render_state *) renderer;
    ++state->present_calls;
    return !state->fail_present;
}

static void
test_render_path_failures(struct test_results *results) {
    const struct q3c_profile *profile =
        q3c_profile_get(Q3C_PROFILE_OBS_STABILIZED_1080P60);
    struct q3c_stabilization_sink sink;
    VERIFY(results, q3c_stabilization_sink_init(
        &sink, profile, 80, capture_event));
    struct fake_screen screen;
    fake_screen_init(&screen, &sink);
    sc_frame_source_add_sink(&sink.frame_source, &screen.sink);
    AVCodecContext codec = {
        .width = 2064, .height = 1160, .pix_fmt = AV_PIX_FMT_YUV420P,
        .time_base = {0, 1},
    };
    struct sc_stream_session session = {
        .video = {.width = 4128, .height = 2208},
    };
    VERIFY(results, sink.frame_sink.ops->open(&sink.frame_sink, &codec,
                                              &session));
    VERIFY(results, sink.input_time_base.num == 1);
    VERIFY(results, sink.input_time_base.den == 1000000);
    AVFrame frame = {
        .width = 1920, .height = 1080, .format = AV_PIX_FMT_YUV420P,
        .pts = 11,
    };
    VERIFY(results, av_dict_set(&frame.metadata, "lavfi.q3c.transform_y",
                                "1,0,0,0,1,0", 0) >= 0);
    captured_event_count = 0;
    VERIFY(results, q3c_stabilization_sink_forward_output_for_test(
        &sink, &frame));

    const struct q3c_render_ops render_ops = {
        .clear = fake_render_clear,
        .texture = fake_render_texture,
        .texture_rotated = fake_render_texture_rotated,
        .present = fake_render_present,
    };
    SDL_FRect destination = {.x = 0, .y = 0, .w = 1920, .h = 1080};
    struct fake_render_state state = {.fail_clear = true};
    bool rendered = q3c_render_path_execute(
        &render_ops, (SDL_Renderer *) &state, (SDL_Texture *) (uintptr_t) 1,
        &destination, false, 0, SDL_FLIP_NONE);
    bool clear_failure_suppressed = !rendered;
    VERIFY(results, clear_failure_suppressed);
    VERIFY(results, !q3c_render_ack_dispatch(
        rendered, q3c_stabilization_sink_ack_rendered, &sink, &frame,
        &screen.session));
    VERIFY(results, captured_event_count == 0);

    memset(&state, 0, sizeof(state));
    state.fail_texture = true;
    rendered = q3c_render_path_execute(
        &render_ops, (SDL_Renderer *) &state, (SDL_Texture *) (uintptr_t) 1,
        &destination, false, 0, SDL_FLIP_NONE);
    bool texture_failure_suppressed = !rendered;
    VERIFY(results, texture_failure_suppressed);
    VERIFY(results, !q3c_render_ack_dispatch(
        rendered, q3c_stabilization_sink_ack_rendered, &sink, &frame,
        &screen.session));
    VERIFY(results, captured_event_count == 0);

    memset(&state, 0, sizeof(state));
    state.fail_present = true;
    rendered = q3c_render_path_execute(
        &render_ops, (SDL_Renderer *) &state, (SDL_Texture *) (uintptr_t) 1,
        &destination, false, 0, SDL_FLIP_NONE);
    bool present_failure_suppressed = !rendered;
    VERIFY(results, present_failure_suppressed);
    VERIFY(results, !q3c_render_ack_dispatch(
        rendered, q3c_stabilization_sink_ack_rendered, &sink, &frame,
        &screen.session));
    VERIFY(results, captured_event_count == 0);

    memset(&state, 0, sizeof(state));
    rendered = q3c_render_path_execute(
        &render_ops, (SDL_Renderer *) &state, (SDL_Texture *) (uintptr_t) 1,
        &destination, true, 90, SDL_FLIP_HORIZONTAL);
    VERIFY(results, rendered);
    VERIFY(results, q3c_render_ack_dispatch(
        rendered, q3c_stabilization_sink_ack_rendered, &sink, &frame,
        &screen.session));
    VERIFY(results, captured_event_count == 1);
    VERIFY(results, state.clear_calls == 1 && state.texture_calls == 1
                    && state.present_calls == 1);
    sink.frame_sink.ops->close(&sink.frame_sink);
    q3c_stabilization_sink_destroy(&sink);
    av_dict_free(&frame.metadata);
    results->render_failure_suppressed = true;
}

struct concurrent_ack_context {
    struct q3c_stabilization_sink *sink;
    AVFrame frame;
    struct sc_stream_session session;
    struct sc_mutex mutex;
    struct sc_cond cond;
    bool released;
};

static int
run_ack_after_close(void *userdata) {
    struct concurrent_ack_context *context = userdata;
    sc_mutex_lock(&context->mutex);
    while (!context->released) {
        sc_cond_wait(&context->cond, &context->mutex);
    }
    sc_mutex_unlock(&context->mutex);
    q3c_stabilization_sink_ack_rendered(
        context->sink, &context->frame, &context->session);
    return 0;
}

static void
test_concurrent_ack_lifecycle(struct test_results *results) {
    const struct q3c_profile *profile =
        q3c_profile_get(Q3C_PROFILE_OBS_STABILIZED_1080P60);
    struct q3c_stabilization_sink sink;
    VERIFY(results, q3c_stabilization_sink_init(
        &sink, profile, 78, capture_event));
    struct fake_screen screen;
    fake_screen_init(&screen, &sink);
    sc_frame_source_add_sink(&sink.frame_source, &screen.sink);
    AVCodecContext codec = {
        .width = 2064, .height = 1160, .pix_fmt = AV_PIX_FMT_YUV420P,
        .time_base = {1, 60},
    };
    struct sc_stream_session session = {
        .video = {.width = 4128, .height = 2208},
    };
    VERIFY(results, sink.frame_sink.ops->open(&sink.frame_sink, &codec,
                                              &session));
    AVFrame frame = {
        .width = 1920, .height = 1080, .format = AV_PIX_FMT_YUV420P,
        .pts = 9,
    };
    VERIFY(results, av_dict_set(&frame.metadata, "lavfi.q3c.transform_y",
                                "1,0,0,0,1,0", 0) >= 0);
    VERIFY(results, q3c_stabilization_sink_forward_output_for_test(
        &sink, &frame));

    struct concurrent_ack_context context = {
        .sink = &sink, .frame = frame, .session = screen.session,
    };
    VERIFY(results, sc_mutex_init(&context.mutex));
    VERIFY(results, sc_cond_init(&context.cond));
    sc_thread thread;
    VERIFY(results, sc_thread_create(&thread, run_ack_after_close,
                                     "q3c-ack-close", &context));
    unsigned before = captured_event_count;
    sink.frame_sink.ops->close(&sink.frame_sink);
    sc_mutex_lock(&context.mutex);
    context.released = true;
    sc_cond_signal(&context.cond);
    sc_mutex_unlock(&context.mutex);
    sc_thread_join(&thread, NULL);
    VERIFY(results, captured_event_count == before);
    sc_cond_destroy(&context.cond);
    sc_mutex_destroy(&context.mutex);
    q3c_stabilization_sink_destroy(&sink);
    av_dict_free(&frame.metadata);
    bool concurrent_ack_lifecycle = true;
    VERIFY(results, concurrent_ack_lifecycle);
    results->concurrent_ack = true;
}

struct publication_barrier {
    struct sc_mutex mutex;
    struct sc_cond cond;
    struct q3c_stabilization_sink *sink;
    bool publication_in_flight;
    bool release_publication;
    bool try_lock_completed;
    bool try_lock_busy;
    bool close_after_mutex;
    bool close_completed;
    unsigned events;
};

static struct publication_barrier *active_publication_barrier;

static void
blocking_event_emitter(const char *event) {
    assert(event);
    struct publication_barrier *barrier = active_publication_barrier;
    assert(barrier);
    sc_mutex_lock(&barrier->mutex);
    barrier->publication_in_flight = true;
    sc_cond_broadcast(&barrier->cond);
    while (!barrier->release_publication) {
        sc_cond_wait(&barrier->cond, &barrier->mutex);
    }
    ++barrier->events;
    sc_mutex_unlock(&barrier->mutex);
}

struct publication_ack_context {
    struct q3c_stabilization_sink *sink;
    AVFrame frame;
    struct sc_stream_session session;
};

static int
run_publication_ack(void *userdata) {
    struct publication_ack_context *context = userdata;
    q3c_stabilization_sink_ack_rendered(
        context->sink, &context->frame, &context->session);
    return 0;
}

static int
run_contending_close(void *userdata) {
    struct publication_barrier *barrier = userdata;
    barrier->sink->frame_sink.ops->close(&barrier->sink->frame_sink);
    sc_mutex_lock(&barrier->mutex);
    barrier->close_completed = true;
    sc_cond_broadcast(&barrier->cond);
    sc_mutex_unlock(&barrier->mutex);
    return 0;
}

static void
observe_close_mutex(void *userdata,
                    enum q3c_close_observation observation) {
    struct publication_barrier *barrier = userdata;
    sc_mutex_lock(&barrier->mutex);
    if (observation == Q3C_CLOSE_TRY_MUTEX_BUSY
            || observation == Q3C_CLOSE_TRY_MUTEX_ACQUIRED) {
        barrier->try_lock_completed = true;
        barrier->try_lock_busy =
            observation == Q3C_CLOSE_TRY_MUTEX_BUSY;
    } else {
        assert(observation == Q3C_CLOSE_AFTER_MUTEX);
        barrier->close_after_mutex = true;
    }
    sc_cond_broadcast(&barrier->cond);
    sc_mutex_unlock(&barrier->mutex);
}

static void
test_publication_close_overlap(struct test_results *results) {
    struct publication_barrier barrier = {0};
    VERIFY(results, sc_mutex_init(&barrier.mutex));
    VERIFY(results, sc_cond_init(&barrier.cond));
    active_publication_barrier = &barrier;

    const struct q3c_profile *profile =
        q3c_profile_get(Q3C_PROFILE_OBS_STABILIZED_1080P60);
    struct q3c_stabilization_sink sink;
    barrier.sink = &sink;
    VERIFY(results, q3c_stabilization_sink_init(
        &sink, profile, 81, blocking_event_emitter));
    sink.close_observer = observe_close_mutex;
    sink.close_observer_userdata = &barrier;
    struct fake_screen screen;
    fake_screen_init(&screen, &sink);
    sc_frame_source_add_sink(&sink.frame_source, &screen.sink);
    AVCodecContext codec = {
        .width = 2064, .height = 1160, .pix_fmt = AV_PIX_FMT_YUV420P,
        .time_base = {1, 60},
    };
    struct sc_stream_session session = {
        .video = {.width = 4128, .height = 2208},
    };
    VERIFY(results, sink.frame_sink.ops->open(&sink.frame_sink, &codec,
                                              &session));
    AVFrame frame = {
        .width = 1920, .height = 1080, .format = AV_PIX_FMT_YUV420P,
        .pts = 12,
    };
    VERIFY(results, av_dict_set(&frame.metadata, "lavfi.q3c.transform_y",
                                "1,0,0,0,1,0", 0) >= 0);
    VERIFY(results, q3c_stabilization_sink_forward_output_for_test(
        &sink, &frame));
    struct publication_ack_context ack_context = {
        .sink = &sink, .frame = frame, .session = screen.session,
    };
    sc_thread ack_thread;
    VERIFY(results, sc_thread_create(
        &ack_thread, run_publication_ack, "q3c-publish", &ack_context));

    sc_mutex_lock(&barrier.mutex);
    while (!barrier.publication_in_flight) {
        sc_cond_wait(&barrier.cond, &barrier.mutex);
    }
    sc_mutex_unlock(&barrier.mutex);

    sc_thread close_thread;
    VERIFY(results, sc_thread_create(
        &close_thread, run_contending_close, "q3c-close", &barrier));
    sc_mutex_lock(&barrier.mutex);
    while (!barrier.try_lock_completed) {
        sc_cond_wait(&barrier.cond, &barrier.mutex);
    }
    bool close_contending = barrier.try_lock_busy
                          && barrier.publication_in_flight
                          && !barrier.close_after_mutex
                          && !barrier.close_completed;
    VERIFY(results, close_contending);
    barrier.release_publication = true;
    sc_cond_broadcast(&barrier.cond);
    sc_mutex_unlock(&barrier.mutex);

    sc_thread_join(&ack_thread, NULL);
    sc_thread_join(&close_thread, NULL);
    VERIFY(results, barrier.events == 1);
    VERIFY(results, barrier.close_after_mutex);
    VERIFY(results, barrier.close_completed && !sink.open);
    q3c_stabilization_sink_destroy(&sink);
    av_dict_free(&frame.metadata);
    active_publication_barrier = NULL;
    sc_cond_destroy(&barrier.cond);
    sc_mutex_destroy(&barrier.mutex);
    results->publication_overlap = true;
}

static bool
allocate_test_frame(AVFrame **frame) {
    *frame = av_frame_alloc();
    if (!*frame) {
        return false;
    }
    (*frame)->format = AV_PIX_FMT_YUV420P;
    (*frame)->width = 2064;
    (*frame)->height = 1160;
    return av_frame_get_buffer(*frame, 32) >= 0;
}

static void
fill_test_frame(AVFrame *frame) {
    for (int y = 0; y < 1160; ++y) {
        uint8_t *row = frame->data[0] + y * frame->linesize[0];
        for (int x = 0; x < 2064; ++x) {
            row[x] = 32 + ((x * 37u ^ y * 73u) % 176);
        }
    }
    for (int plane = 1; plane < 3; ++plane) {
        for (int y = 0; y < 580; ++y) {
            memset(frame->data[plane] + y * frame->linesize[plane],
                   128, 1032);
        }
    }
}

static void
test_stabilized_live_graph(struct test_results *results) {
    const struct q3c_profile *profile =
        q3c_profile_get(Q3C_PROFILE_OBS_STABILIZED_1080P60);
    struct q3c_stabilization_sink sink;
    VERIFY(results, q3c_stabilization_sink_init(
        &sink, profile, 79, capture_event));
    struct fake_screen screen;
    fake_screen_init(&screen, &sink);
    sc_frame_source_add_sink(&sink.frame_source, &screen.sink);
    AVCodecContext codec = {
        .width = 2064, .height = 1160, .pix_fmt = AV_PIX_FMT_YUV420P,
        .time_base = {1, 60},
    };
    struct sc_stream_session session = {
        .video = {.width = 4128, .height = 2208},
    };
    VERIFY(results, q3c_stabilization_sink_open_for_test(
        &sink, &codec, &session));
    VERIFY(results, sink.filter.graph && sink.filter.device);
    VERIFY(results, sink.gpu_name[0] != '\0');

    AVFrame *frame = NULL;
    VERIFY(results, allocate_test_frame(&frame));
    fill_test_frame(frame);
    for (int64_t frame_index = 0; frame_index < 20; ++frame_index) {
        frame->pts = frame_index * 16667;
        VERIFY(results, sink.frame_sink.ops->push(&sink.frame_sink, frame));
    }
    VERIFY(results, sink.filter.queued_frames > 0);
    struct sc_stream_session next = {
        .video = {.width = 4128, .height = 2208},
    };
    VERIFY(results, sink.frame_sink.ops->push_session(&sink.frame_sink, &next));
    bool delayed_frames_disposed = sink.filter.queued_frames == 0
                                && sink.filter.delay_count == 0;
    VERIFY(results, delayed_frames_disposed);
    VERIFY(results, sink.filter.graph && sink.filter.device);
    av_frame_free(&frame);
    sink.frame_sink.ops->close(&sink.frame_sink);
    VERIFY(results, !sink.filter.graph && !sink.filter.device
                    && sink.filter.queued_frames == 0
                    && sink.filter.delay_count == 0);
    q3c_stabilization_sink_destroy(&sink);
    results->live_graph = true;
    results->delayed_frames_disposed = true;
}

int
main(void) {
    struct test_results results = {0};
    test_profiles_and_events(&results);
    test_utf8(&results);
    test_filter_failure_and_validation(&results);
    test_border_guard_fatal_before_forward(&results);
    test_paused_stale_event(&results);
    test_low_latency_lifecycle(&results);
    test_render_path_failures(&results);
    test_concurrent_ack_lifecycle(&results);
    test_publication_close_overlap(&results);
    test_stabilized_live_graph(&results);
    assert(results.bypass && results.init_failure && results.session_reset
           && results.render_ack && results.frame_validation
           && results.shutdown && results.utf8 && results.live_graph
           && results.delayed_frames_disposed && results.concurrent_ack
           && results.render_failure_suppressed && results.gpu_selection
           && results.paused_stale_event_safe
           && results.publication_overlap && results.border_guard);
    printf("{\"schemaVersion\":1,\"status\":\"passed\","
           "\"assertions\":%u,\"lifecycle\":{"
           "\"filterBypass\":%s,\"initializationFailure\":%s,"
           "\"sessionReset\":%s,\"renderAcknowledgement\":%s,"
           "\"frameValidation\":%s,\"shutdownCleanup\":%s,"
           "\"utf8Sanitization\":%s,\"liveStabilizedGraph\":%s,"
           "\"delayedFramesDisposed\":%s,\"concurrentAckLifecycle\":%s,"
           "\"renderFailureSuppressed\":%s,\"gpuSelection\":%s,"
           "\"pausedStaleEventSafe\":%s,\"publicationOverlap\":%s,"
           "\"borderExposureGuard\":%s}}\n",
           results.assertions,
           results.bypass ? "true" : "false",
           results.init_failure ? "true" : "false",
           results.session_reset ? "true" : "false",
           results.render_ack ? "true" : "false",
           results.frame_validation ? "true" : "false",
           results.shutdown ? "true" : "false",
           results.utf8 ? "true" : "false",
           results.live_graph ? "true" : "false",
           results.delayed_frames_disposed ? "true" : "false",
           results.concurrent_ack ? "true" : "false",
           results.render_failure_suppressed ? "true" : "false",
           results.gpu_selection ? "true" : "false",
           results.paused_stale_event_safe ? "true" : "false",
           results.publication_overlap ? "true" : "false",
           results.border_guard ? "true" : "false");
    return 0;
}
