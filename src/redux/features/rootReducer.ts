import { combineReducers } from "@reduxjs/toolkit";
import baseApi from "../api/baseApi";

// 07-08 deletion release (AUTH-08): the Redux auth slice (token mirror) is
// deleted with the legacy auth stack — Redux remains for UI/domain state
// only, and authenticated fetches rely solely on cookie credentials.

const rootReducer = combineReducers({
  [baseApi.reducerPath]: baseApi.reducer,
});

export default rootReducer;
