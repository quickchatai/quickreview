I found no real bugs in this diff (382720b8...699b45c0). Every change fixes a compiler warning and keeps the same behaviour:

- **`src/Mod/Fem/App/FemVTKTools.cpp`:** `countScaPos` changed to `size_t`, which now matches the `std::vector<size_t>` returned by `identifyScalarEntities`. Dropping the unused `ex` from the catch is harmless.
- **`src/Mod/Spreadsheet/App/PropertySheet.cpp`:** it now passes a `std::string` in place of `.c_str()`. That still calls the same `ObjectIdentifier(owner, const std::string&, int)` constructor. A `const char*` could never have matched the `bool localProperty` overload anyway.
- **`src/Mod/TechDraw/Gui/DimensionValidators.cpp`:** the new `default: break;` cases lead to the same `return dimType` as before.
- **`src/Base/StackWalker.cpp`:** `case NumSymTypes` is a real value of the `SYM_TYPE` enum. The format specifiers moved from `%d` to `%ld` for `DWORD`. `%lu` would be strictly correct, but the old code was signed too, so nothing got worse.
- **`src/Mod/CAM/libarea/pyarea.cpp`:** `%zu` works with MSVC 2015 and later.
- **The rest:** float literals and casts, the lambda capture that was never used, `[[maybe_unused]]`, and `EXPECT_DOUBLE_EQ` all behave the same as before.

No findings were reported.
