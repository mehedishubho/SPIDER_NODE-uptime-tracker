import { configureStore } from "@reduxjs/toolkit";
import {
  FLUSH,
  PAUSE,
  PERSIST,
  persistStore,
  PURGE,
  REGISTER,
  REHYDRATE,
} from "redux-persist";
import baseApi from "./api/baseApi";
import persistReducer from "redux-persist/es/persistReducer";
import storage from "redux-persist/lib/storage";
import rootReducer from "./features/rootReducer";

const persistConfig = {
  key: "root",
  storage,
  // 07-08 deletion release (AUTH-08): the auth slice (the only whitelisted
  // key — the token mirror) is deleted; nothing is persisted until a UI /
  // domain slice earns it.
  whitelist: [] as string[],
};

const persistedReducer = persistReducer(persistConfig, rootReducer);

// use the real root reducer state type for middleware generics
export type RootState = ReturnType<typeof rootReducer>;

export const store = configureStore({
  reducer: persistedReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
      },
    }).concat(baseApi.middleware),
});

export type AppDispatch = typeof store.dispatch;

export const persistor = persistStore(store);
