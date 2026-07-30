#![allow(non_snake_case)]

use std::cell::RefCell;
use std::iter::Iterator;

use neon::prelude::*;

#[cfg(windows)]
use win32console::console::WinConsole;

fn alloc_console(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    #[cfg(windows)]
    if let Err(e) = WinConsole::alloc_console() {
        return cx.throw_error(e.to_string());
    } else if let Err(e) = WinConsole::set_title("karafriends native console") {
        return cx.throw_error(e.to_string());
    }
    Ok(cx.undefined())
}

fn input_devices(mut cx: FunctionContext) -> JsResult<JsArray> {
    let input_devices: Vec<_> = match karafriends_lib::InputDevice::collect_devices() {
        Ok(devices) => devices,
        Err(e) => return cx.throw_error(e.to_string()),
    };
    let js_array = JsArray::new(&mut cx, input_devices.len());
    for (i, (name, config)) in input_devices.iter().enumerate() {
        let js_name = cx.string(name);
        let js_channel_count = cx.number(config.channels);
        let inner_array = JsArray::new(&mut cx, 2);
        inner_array.set(&mut cx, 0, js_name)?;
        inner_array.set(&mut cx, 1, js_channel_count)?;
        js_array.set(&mut cx, i as u32, inner_array)?;
    }
    Ok(js_array)
}

fn input_device__new(
    mut cx: FunctionContext,
) -> JsResult<JsBox<RefCell<karafriends_lib::InputDevice>>> {
    let name = cx.argument::<JsString>(0)?.value(&mut cx);
    let channel_selection = cx.argument::<JsNumber>(1)?.value(&mut cx) as usize;
    let device = match karafriends_lib::InputDevice::new(&name, channel_selection) {
        Ok(device) => device,
        Err(e) => return cx.throw_error(e.to_string()),
    };
    Ok(cx.boxed(RefCell::new(device)))
}

// Every reading since the last call, oldest first. A batch rather than one
// value because the analysis hop is finer than the caller's poll interval --
// see karafriends_lib::pitch_framer.
fn input_device__get_pitches(mut cx: FunctionContext) -> JsResult<JsArray> {
    let device = cx.argument::<JsBox<RefCell<karafriends_lib::InputDevice>>>(0)?;
    let mut device = device.borrow_mut();
    let estimates = match device.get_pitches() {
        Ok(estimates) => estimates,
        Err(e) => return cx.throw_error(e.to_string()),
    };

    let js_array = JsArray::new(&mut cx, estimates.len());
    for (i, estimate) in estimates.iter().enumerate() {
        let js_object = JsObject::new(&mut cx);
        let age_ms = cx.number(estimate.age_ms);
        let midi_number = cx.number(estimate.midi_number);
        let confidence = cx.number(estimate.confidence);
        let rms = cx.number(estimate.rms);
        js_object.set(&mut cx, "ageMs", age_ms)?;
        js_object.set(&mut cx, "midiNumber", midi_number)?;
        js_object.set(&mut cx, "confidence", confidence)?;
        js_object.set(&mut cx, "rms", rms)?;
        js_array.set(&mut cx, i as u32, js_object)?;
    }
    Ok(js_array)
}

fn input_device__set_mic_output_enabled(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let device = cx.argument::<JsBox<RefCell<karafriends_lib::InputDevice>>>(0)?;
    let enabled = cx.argument::<JsBoolean>(1)?.value(&mut cx);
    device.borrow().set_mic_output_enabled(enabled);
    Ok(cx.undefined())
}

fn input_device__stop(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let device = cx.argument::<JsBox<RefCell<karafriends_lib::InputDevice>>>(0)?;
    if let Err(e) = device.borrow().stop() {
        return cx.throw_error(e.to_string());
    }
    Ok(cx.undefined())
}

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    cx.export_function("allocConsole", alloc_console)?;
    cx.export_function("inputDevices", input_devices)?;
    cx.export_function("inputDevice_new", input_device__new)?;
    cx.export_function("inputDevice_getPitches", input_device__get_pitches)?;
    cx.export_function(
        "inputDevice_setMicOutputEnabled",
        input_device__set_mic_output_enabled,
    )?;
    cx.export_function("inputDevice_stop", input_device__stop)?;

    Ok(())
}
